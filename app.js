/* ===== 原材料价格数据库 - 核心逻辑 ===== */

// 版本号：每次发布新功能都改这里，用于前端自我诊断（页脚可见）
const APP_VERSION = '2026.09.23-c';

// ===== 数据层 =====
const STORE_KEY = 'rawMaterialPriceDB';
const MATERIAL_DB_KEY = 'materialDB';
const CATEGORIES = ['主材', '机辅料', '包装物', '其它'];
const isKnownCategory = (c) => CATEGORIES.includes(c);

function loadData() {
  const raw = localStorage.getItem(STORE_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveData(data) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
  schedulePush();
}

function loadMaterialDB() {
  const raw = localStorage.getItem(MATERIAL_DB_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveMaterialDB(data) {
  localStorage.setItem(MATERIAL_DB_KEY, JSON.stringify(data));
  schedulePush();
}

let records = loadData();
let materials = loadMaterialDB();
let editingId = null; // 当前正在编辑的记录id（null=新增模式）

// ===== 定价时间默认值（按「材料::供应商」记忆）=====
// 规则：非新供应商时，定价时间默认取该组合「上次定价时间」（供货时间与定价时间是不同概念）；
// 用户手动改过定价时间后，该值即成为后续默认值，直到再次手动修改。
const PD_DEFAULTS_KEY = 'rm_pricing_date_defaults';
let pricingDateDefaults = {};
try { pricingDateDefaults = JSON.parse(localStorage.getItem(PD_DEFAULTS_KEY) || '{}'); } catch (e) { pricingDateDefaults = {}; }
let pricingDateTouched = false; // 当前表单内用户是否手动改过定价时间

function lastPricingDate(materialName, supplier) {
  const name = (materialName || '').trim();
  const sup = (supplier || '').trim();
  if (!name || !sup) return '';
  let best = '';
  records.forEach(r => {
    if ((r.materialName || '').trim() === name && (r.supplier || '').trim() === sup) {
      const d = r.pricingDate || '';
      if (d && d > best) best = d;
    }
  });
  return best;
}

function defaultPricingDate(materialName, supplier) {
  const key = (materialName || '').trim() + '::' + (supplier || '').trim();
  if (key && pricingDateDefaults[key]) return pricingDateDefaults[key];
  return lastPricingDate(materialName, supplier);
}

function savePricingDateDefault(materialName, supplier, date) {
  const key = (materialName || '').trim() + '::' + (supplier || '').trim();
  if (!key) return;
  pricingDateDefaults[key] = date;
  localStorage.setItem(PD_DEFAULTS_KEY, JSON.stringify(pricingDateDefaults));
}

function applyPricingDateDefault() {
  if (pricingDateTouched) return;
  const name = document.getElementById('materialName').value.trim();
  const sup = getSupplierValue();
  const def = defaultPricingDate(name, sup);
  if (def) document.getElementById('pricingDate').value = def;
}

function onPricingDateManualEdit() {
  pricingDateTouched = true;
  const name = document.getElementById('materialName').value.trim();
  const sup = getSupplierValue();
  const d = document.getElementById('pricingDate').value;
  if (name && sup && d) savePricingDateDefault(name, sup, d);
}

// ===== 多端联网同步（Supabase：本地优先、无登录、board 串多端共享） =====
// 模型与「工作台」一致：本地 localStorage 为权威，保存即防抖推送到云端；
// 云端按 board 串共享一行；拉取时按时间戳 last-write-wins（后保存的赢）。
// 开启需先在 Supabase SQL 编辑器执行本页源码末尾的建表语句（表 rawmat_state）。
const SYNCSB = {
  enabled: localStorage.getItem('rm_sync_enabled') === '1',
  url: 'https://gcwehwqcccmjxrqtolev.supabase.co',
  anon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdjd2Vod3FjY2NtanhycXRvbGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MTQzNDAsImV4cCI6MjEwMDE5MDM0MH0.X0X-75d1wPSTXECZDRVtkWVyDaj9ot9JLp_Qc2YamB8',
  board: 'rm_audit_3f7a9c2d1b8e4f60',
  table: 'rawmat_state'
};
let _sbClient = null;
let _pushTimer = null;
let _localTs = Number(localStorage.getItem('rm_sync_ts') || 0);
let _sbReady = null;

// supabase 脚本是 async 加载，可能晚于 app.js 执行；这里等它就绪（最多 ~5s）
function sbReadyPromise() {
  if (typeof supabase !== 'undefined') return Promise.resolve();
  if (_sbReady) return _sbReady;
  _sbReady = new Promise((res) => {
    let n = 0;
    const t = setInterval(() => {
      if (typeof supabase !== 'undefined' || ++n > 50) { clearInterval(t); res(); }
    }, 100);
  });
  return _sbReady;
}

function sbClient() {
  if (!SYNCSB.enabled || !SYNCSB.url || !SYNCSB.anon || typeof supabase === 'undefined') return null;
  if (!_sbClient) {
    try { _sbClient = supabase.createClient(SYNCSB.url, SYNCSB.anon); } catch (e) { return null; }
  }
  return _sbClient;
}

function setSyncState(t) {
  const el = document.getElementById('sync-state');
  if (el) el.textContent = t;
}

function getSyncPayload() {
  return { records: records, materials: materials, _ts: Date.now() };
}

// 直接写回 localStorage（绕过 schedulePush，避免拉取后又被回推）
function applySyncPayload(p) {
  if (!p || !Array.isArray(p.records) || !Array.isArray(p.materials)) return false;
  records = p.records;
  materials = p.materials;
  localStorage.setItem(STORE_KEY, JSON.stringify(records));
  localStorage.setItem(MATERIAL_DB_KEY, JSON.stringify(materials));
  refreshAll();
  return true;
}

function schedulePush() {
  if (!SYNCSB.enabled) return;
  if (!sbClient()) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushState, 700);
}

async function pushState() {
  await sbReadyPromise();
  const sb = sbClient();
  if (!sb) return;
  setSyncState('同步中…');
  const payload = getSyncPayload();
  _localTs = payload._ts;
  localStorage.setItem('rm_sync_ts', String(_localTs));
  try {
    const { error } = await sb.from(SYNCSB.table).upsert({
      id: SYNCSB.board,
      data: payload,
      updated_at: new Date(payload._ts).toISOString()
    });
    if (error) throw error;
    setSyncState('已同步');
  } catch (e) {
    setSyncState('同步失败');
  }
}

async function pullState() {
  await sbReadyPromise();
  const sb = sbClient();
  if (!sb) return;
  setSyncState('同步中…');
  try {
    const { data, error } = await sb.from(SYNCSB.table)
      .select('data,updated_at').eq('id', SYNCSB.board).maybeSingle();
    if (error) throw error;
    if (data && data.data && typeof data.data._ts === 'number') {
      if (data.data._ts > _localTs) {
        _localTs = data.data._ts;
        localStorage.setItem('rm_sync_ts', String(_localTs));
        applySyncPayload(data.data);
        setSyncState('已同步');
      } else {
        setSyncState('已同步');
      }
    } else {
      setSyncState('已同步');
    }
  } catch (e) {
    setSyncState('同步失败');
  }
}

function startSync() {
  if (!SYNCSB.enabled) { setSyncState('未开启'); return; }
  // 等 supabase 库就绪后再开始轮询（避免 async 脚本尚未加载时静默失败）
  sbReadyPromise().then(() => {
    pullState();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pullState();
    });
    setInterval(pullState, 30000);
  });
}

function toggleSync() {
  const on = document.getElementById('syncEnabled').checked;
  SYNCSB.enabled = on;
  localStorage.setItem('rm_sync_enabled', on ? '1' : '0');
  if (on) {
    startSync();
    pushState(); // 把本地现有数据上传到云端
    showToast('已开启联网同步', 'success');
  } else {
    setSyncState('未开启');
  }
}

function manualSync() {
  if (!SYNCSB.enabled) { showToast('请先开启联网同步', 'error'); return; }
  pullState().then(() => pushState());
}
let editingMaterialName = null; // 当前正在编辑的材料名称（null=新增模式）
let sortField = 'pricingDate';
let sortAsc = false;
let trendChartInstance = null;
let compareChartInstance = null;
let amountChartInstance = null;
let supplierSortField = 'totalAmount';
let supplierSortAsc = false;
let materialSortField = 'name';
let materialSortAsc = true;
const ALERT_THRESHOLD = 10; // 环比±10%预警

// ===== Toast =====
function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  setTimeout(() => { toast.className = 'toast'; }, 2500);
}

// ===== Tab切换 =====
function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById('tab-' + tabId).classList.add('active');

  if (tabId === 'list') renderTable();
  if (tabId === 'trend') { initTrendTab(); renderTrend(); }
  if (tabId === 'stats') renderStats();
  if (tabId === 'suppliers') renderSuppliers();
  if (tabId === 'materials') renderMaterials();
}

// ===== 数据录入 / 编辑 =====
function saveRecord(e) {
  e.preventDefault();
  const name = document.getElementById('materialName').value.trim();
  const price = parseFloat(document.getElementById('price').value);
  const quantity = parseFloat(document.getElementById('quantity').value);

  if (!name || isNaN(price) || isNaN(quantity)) {
    showToast('请填写完整数据', 'error');
    return;
  }

  // 供货时间为必选（新增时强制）；定价时间改为可选
  const supplyDate = document.getElementById('supplyDate').value;
  if (!editingId && !supplyDate) {
    showToast('请填写供货时间', 'error');
    return;
  }

  const common = {
    materialName: name,
    category: document.getElementById('category').value,
    unit: document.getElementById('unit').value,
    price: price,
    quantity: quantity,
    totalAmount: +(price * quantity).toFixed(2),
    pricingDate: document.getElementById('pricingDate').value,
    supplyDate: supplyDate,
    supplier: getSupplierValue(),
    remark: document.getElementById('remark').value.trim()
  };

  if (editingId) {
    // 更新模式：修改原记录，不新增
    const idx = records.findIndex(r => r.id === editingId);
    if (idx >= 0) {
      records[idx] = { ...records[idx], ...common, updatedAt: new Date().toISOString() };
    }
    editingId = null;
    showToast('已更新记录', 'success');
  } else {
    // 新增模式
    records.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      ...common,
      createdAt: new Date().toISOString()
    });
    showToast('保存成功！', 'success');
  }

  saveData(records);
  resetForm();
  refreshAll();
}

function resetForm() {
  document.getElementById('entryForm').reset();
  setDefaultDate();
  pricingDateTouched = false; // 新录入：允许按材料+供应商套用默认定价时间
  setSupplierValue('');
  // 退出编辑模式
  editingId = null;
  const btn = document.getElementById('submitBtn');
  if (btn) {
    btn.textContent = '💾 保存';
    btn.classList.remove('btn-warning');
  }
  const hint = document.getElementById('formHint');
  if (hint) hint.textContent = '';
  const del = document.getElementById('deleteRecordBtn');
  if (del) del.style.display = 'none';
}

function setDefaultDate() {
  document.getElementById('pricingDate').value = new Date().toISOString().slice(0, 10);
}

// ===== 自动补全名称 =====
function refreshMaterialList() {
  // 合并「已录入记录」+「材料库」中的材料名，保证在材料库新增的材料能立即出现在录入建议里
  const fromRecords = records.map(r => r.materialName);
  const fromDB = materials.map(m => m.name);
  const names = [...new Set([...fromRecords, ...fromDB])].filter(Boolean).sort();
  const datalist = document.getElementById('materialList');
  datalist.innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

// 录入表单的计量单位 <select> 是固定选项；若材料库/记录里的单位不在列表中，
// 动态补一个 option 再选中，保证「同步计量单位」对任意单位都生效（避免个别单位找不到、不同步）
function ensureUnitOption(value) {
  if (!value) return;
  const sel = document.getElementById('unit');
  if (!sel) return;
  if (![...sel.options].some(o => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    sel.appendChild(opt);
  }
  sel.value = value;
}

// 勾稽：从已录入记录中取某材料的历史供应商（按最近定价时间倒序）
function suppliersForMaterial(materialName) {
  const name = (materialName || '').trim();
  if (!name) return [];
  const lastDate = {};
  const set = new Set();
  records.forEach(r => {
    if ((r.materialName || '').trim() !== name) return;
    const s = (r.supplier || '').trim();
    if (!s) return;
    set.add(s);
    if (!lastDate[s] || (r.pricingDate || '') > lastDate[s]) lastDate[s] = r.pricingDate || '';
  });
  return [...set].sort((a, b) => (lastDate[b] || '').localeCompare(lastDate[a] || ''));
}

// 供应商下拉：随已录入记录自动更新，并与「材料名称」勾稽联动
function refreshSupplierList() {
  const matName = (document.getElementById('materialName')?.value || '').trim();
  const linked = suppliersForMaterial(matName);
  // 该材料有历史供应商 → 只显示这些；没有 → 回退显示供应商库全部（保证可用）
  const names = linked.length
    ? linked
    : [...new Set(records.map(r => (r.supplier || '').trim()).filter(Boolean))].sort();

  const select = document.getElementById('supplierSelect');
  if (!select) return;
  const current = select.value;
  const hintHtml = linked.length
    ? `<option value="__hint__" disabled>—— 「${esc(matName)}」的历史供应商（${linked.length} 家）——</option>`
    : (matName
      ? `<option value="__hint__" disabled>—— 「${esc(matName)}」暂无历史供应商 · 以下为供应商库全部 ——</option>`
      : '');

  select.innerHTML = '<option value="">请选择或新增供应商</option>' + hintHtml +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option value="__new__">➕ 新增供应商...</option>';
  // 保留当前选择，如果它仍在新列表中
  if (current && (names.includes(current) || current === '__new__')) {
    select.value = current;
  }
}

function onSupplierSelectChange() {
  const select = document.getElementById('supplierSelect');
  const input = document.getElementById('supplierInput');
  const btn = document.getElementById('supplierToggleBtn');
  if (select && select.value === '__new__') {
    select.style.display = 'none';
    input.style.display = 'block';
    input.focus();
    if (btn) btn.textContent = '取消';
  } else {
    // 选了已有供应商（非新供应商）→ 定价时间默认取上次供货时间
    pricingDateTouched = false;
    applyPricingDateDefault();
  }
}

function toggleSupplierMode() {
  const select = document.getElementById('supplierSelect');
  const input = document.getElementById('supplierInput');
  const btn = document.getElementById('supplierToggleBtn');
  if (!select || !input || !btn) return;
  if (input.style.display === 'none') {
    // 进入新增模式
    select.value = '__new__';
    select.style.display = 'none';
    input.style.display = 'block';
    input.focus();
    btn.textContent = '取消';
  } else {
    // 取消新增，回到下拉
    input.value = '';
    input.style.display = 'none';
    select.style.display = 'block';
    select.value = '';
    btn.textContent = '新增';
  }
}

function getSupplierValue() {
  const input = document.getElementById('supplierInput');
  const select = document.getElementById('supplierSelect');
  if (input && input.style.display !== 'none') return input.value.trim();
  if (select) return select.value.trim();
  return '';
}

function setSupplierValue(value) {
  const select = document.getElementById('supplierSelect');
  const input = document.getElementById('supplierInput');
  const btn = document.getElementById('supplierToggleBtn');
  if (!select || !input || !btn) return;
  const v = (value || '').trim();
  refreshSupplierList();
  if (v && [...select.options].some(o => o.value === v)) {
    select.style.display = 'block';
    input.style.display = 'none';
    select.value = v;
    btn.textContent = '新增';
  } else if (v) {
    select.style.display = 'none';
    input.style.display = 'block';
    input.value = v;
    select.value = '__new__';
    btn.textContent = '取消';
  } else {
    select.style.display = 'block';
    input.style.display = 'none';
    select.value = '';
    input.value = '';
    btn.textContent = '新增';
  }
}

// ===== 数据总览 =====
function renderTable() {
  const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
  const material = document.getElementById('filterMaterial').value;
  const supplier = document.getElementById('filterSupplier').value;
  const category = document.getElementById('filterCategory').value;
  const month = document.getElementById('filterMonth').value;

  let filtered = records.filter(r => {
    if (keyword) {
      const kw = keyword;
      const hitName = (r.materialName || '').toLowerCase().includes(kw);
      const hitSupplier = (r.supplier || '').toLowerCase().includes(kw);
      if (!hitName && !hitSupplier) return false;
    }
    if (material && r.materialName !== material) return false;
    if (supplier && (r.supplier || '') !== supplier) return false;
    if (category && r.category !== category) return false;
    if (month && !r.pricingDate.startsWith(month)) return false;
    return true;
  });

  // 排序
  filtered.sort((a, b) => {
    let va = a[sortField] ?? '';
    let vb = b[sortField] ?? '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('tableBody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state"><div class="emoji">📭</div>暂无数据，请先录入</td></tr>`;
    document.getElementById('tableFooter').textContent = '';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const dbMat = materials.find(x => x.name === r.materialName);
    const displayUnit = (dbMat && dbMat.unit) ? dbMat.unit : (r.unit || '—');

    return `<tr>
      <td>${r.pricingDate}</td>
      <td>${esc(r.supplyDate) || '—'}</td>
      <td><strong>${esc(r.materialName)}</strong></td>
      <td>${r.category}</td>
      <td>${fmtPrice(r.price)}</td>
      <td>${fmtNum(r.quantity)}</td>
      <td>${displayUnit}</td>
      <td>${fmtNum(r.totalAmount)}</td>
      <td title="${esc(r.supplier) || ''}">${esc(r.supplier) || '—'}</td>
      <td title="${esc(r.remark) || ''}">${esc(r.remark) || '—'}</td>
      <td>
        <button class="btn-link" onclick="editRecord('${r.id}')">编辑</button>
      </td>
    </tr>`;
  }).join('');

  // 汇总
  const totalAmount = filtered.reduce((s, r) => s + r.totalAmount, 0);
  document.getElementById('tableFooter').textContent =
    `共 ${filtered.length} 条记录 | 采购总额：${fmtNum(totalAmount)} 元`;
}

function calcMoM(record, sameMaterialRecords) {
  if (!sameMaterialRecords || sameMaterialRecords.length < 2) return null;
  const idx = sameMaterialRecords.findIndex(r => r.id === record.id);
  if (idx <= 0) return null;
  const prev = sameMaterialRecords[idx - 1];
  if (prev.price === 0) return null;
  const pct = ((record.price - prev.price) / prev.price) * 100;
  return {
    pct: Math.abs(pct),
    direction: pct >= 0 ? 'up' : 'down',
    symbol: pct >= 0 ? '↑' : '↓',
    alert: Math.abs(pct) >= ALERT_THRESHOLD
  };
}

function sortBy(field) {
  if (sortField === field) {
    sortAsc = !sortAsc;
  } else {
    sortField = field;
    sortAsc = true;
  }
  renderTable();
}

function deleteRecord(id) {
  if (!confirm('确认删除该条记录？')) return;
  records = records.filter(r => r.id !== id);
  saveData(records);
  showToast('已删除', 'success');
  refreshAll();
}

// 删除按钮已收进「数据录入」编辑面板：删除当前正在编辑的记录
function deleteCurrentRecord() {
  if (!editingId) return;
  const id = editingId;
  deleteRecord(id);
  if (!records.some(r => r.id === id)) {
    resetForm();
    switchTab('list');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function editRecord(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  editingId = id;
  document.getElementById('materialName').value = r.materialName || '';
  document.getElementById('category').value = r.category || '其他';
  ensureUnitOption(r.unit || '批');
  document.getElementById('price').value = r.price;
  document.getElementById('quantity').value = r.quantity;
  document.getElementById('pricingDate').value = r.pricingDate;
  document.getElementById('supplyDate').value = r.supplyDate || '';
  setSupplierValue(r.supplier || '');
  document.getElementById('remark').value = r.remark || '';
  // 切换按钮与提示，进入编辑态
  const btn = document.getElementById('submitBtn');
  if (btn) {
    btn.textContent = '✏️ 更新';
    btn.classList.add('btn-warning');
  }
  const hint = document.getElementById('formHint');
  if (hint) {
    const supply = r.supplyDate ? `· 供货 ${r.supplyDate}` : '';
    hint.textContent = `正在编辑「${r.materialName}」· 定价 ${r.pricingDate}${supply}（修改后点「更新」，或点「清空」取消）`;
    hint.style.color = '#d97706';
  }
  const del = document.getElementById('deleteRecordBtn');
  if (del) del.style.display = '';
  switchTab('entry');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearFilters() {
  document.getElementById('searchInput').value = '';
  document.getElementById('filterMaterial').value = '';
  document.getElementById('filterSupplier').value = '';
  document.getElementById('filterCategory').value = '';
  document.getElementById('filterMonth').value = '';
  const unitReadout = document.getElementById('materialUnitReadout');
  if (unitReadout) {
    unitReadout.textContent = '';
    unitReadout.style.display = 'none';
    unitReadout.classList.remove('filter-unit-readout-warn');
  }
  refreshMaterialFilter(''); // 重置材料下拉为全部
  refreshSupplierFilter();   // 重置供应商下拉为全部
  renderTable();
}

// ===== 材料库 =====
function renderMaterials() {
  const kw = (document.getElementById('materialSearch')?.value || '').trim().toLowerCase();

  // 按名称聚合价格记录统计
  const recordStats = {};
  records.forEach(r => {
    const name = (r.materialName || '').trim();
    if (!name) return;
    if (!recordStats[name]) recordStats[name] = { count: 0, dates: [] };
    recordStats[name].count++;
    if (r.pricingDate) recordStats[name].dates.push(r.pricingDate);
  });

  // 构建展示列表：材料库 + 有记录但材料库中未定义的材料
  const dbMap = {};
  materials.forEach(m => { dbMap[m.name] = m.category; });

  let list = materials.map(m => ({
    name: m.name,
    category: m.category,
    unit: m.unit || '',
    dept: getMaterialDept(m),
    inDB: true,
    recordCount: recordStats[m.name]?.count || 0,
    lastDate: recordStats[m.name]?.dates.length
      ? recordStats[m.name].dates.reduce((a, b) => a > b ? a : b)
      : ''
  }));

  // 补充有价格记录但不在材料库中的材料（标为「未归类」）
  Object.keys(recordStats).forEach(name => {
    if (!dbMap[name]) {
      list.push({
        name: name,
        category: '—（未在材料库定义）—',
        unit: '',
        dept: '',
        inDB: false,
        recordCount: recordStats[name].count,
        lastDate: recordStats[name].dates.length
          ? recordStats[name].dates.reduce((a, b) => a > b ? a : b)
          : ''
      });
    }
  });

  // 搜索过滤
  if (kw) {
    list = list.filter(m => m.name.toLowerCase().includes(kw));
  }

  // 排序
  list.sort((a, b) => {
    let va = a[materialSortField] ?? '';
    let vb = b[materialSortField] ?? '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return materialSortAsc ? -1 : 1;
    if (va > vb) return materialSortAsc ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('materialBody');
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state"><div class="emoji">📦</div>${kw ? '未找到匹配的材料' : '材料库为空，请从下方添加材料'}</td></tr>`;
    document.getElementById('materialFooter').textContent = '';
    document.getElementById('materialSummary').innerHTML = '';
    return;
  }

  tbody.innerHTML = list.map(m => `
    <tr class="${m.inDB ? '' : 'row-muted'}">
      <td><strong>${esc(m.name)}</strong>${m.inDB ? '' : ' <span style="color:var(--text-light);font-size:12px;">(未归类)</span>'}</td>
      <td>${m.category}</td>
      <td>${m.unit || '—'}</td>
      <td>${m.dept ? esc(m.dept) : '<span class="muted-dash">—</span>'}</td>
      <td>${m.recordCount}</td>
      <td>${m.lastDate || '—'}</td>
      <td>
        ${m.inDB ? `<button class="btn-link" onclick="editMaterial('${esc(m.name)}')\">编辑</button>` : `<button class=\"btn-link\" onclick=\"quickAddMaterial('${esc(m.name)}')\">添加到库</button>`}
      </td>
    </tr>
  `).join('');

  // 汇总卡片
  const dbCount = materials.length;
  const unclassified = list.filter(m => !m.inDB).length;
  const withRecords = list.filter(m => m.recordCount > 0).length;
  document.getElementById('materialSummary').innerHTML = `
    <div class="stat-card">
      <div class="icon">📦</div>
      <div class="stat-label">材料库总数</div>
      <div class="stat-value">${dbCount}</div>
    </div>
    <div class="stat-card">
      <div class="icon">📋</div>
      <div class="stat-label">有价格记录</div>
      <div class="stat-value">${withRecords}</div>
    </div>
    <div class="stat-card">
      <div class="icon">⚠️</div>
      <div class="stat-label">未归类材料</div>
      <div class="stat-value" style="color:${unclassified > 0 ? 'var(--danger)' : 'var(--success)'}">${unclassified}</div>
      <div class="stat-sub">有记录但未在材料库定义</div>
    </div>
  `;

  document.getElementById('materialFooter').textContent =
    `材料库 ${dbCount} 条 | 未归类 ${unclassified} 条`;
}

function sortMaterials(field) {
  if (materialSortField === field) {
    materialSortAsc = !materialSortAsc;
  } else {
    materialSortField = field;
    materialSortAsc = true;
  }
  renderMaterials();
}

// 修改材料库信息后，把同名历史价格记录的 分类/单位/名称 同步成材料库的值（材料库为权威）
function propagateMaterialToRecords(oldName, newMat) {
  let count = 0;
  records.forEach(r => {
    if ((r.materialName || '').trim() === oldName) {
      let changed = false;
      if (r.category !== newMat.category) { r.category = newMat.category; changed = true; }
      // 材料库有标准单位才覆盖，避免把历史记录的单位清空
      if (newMat.unit && r.unit !== newMat.unit) { r.unit = newMat.unit; changed = true; }
      if (r.materialName !== newMat.name) { r.materialName = newMat.name; changed = true; }
      if (changed) count++;
    }
  });
  return count;
}

function saveMaterial(e) {
  e.preventDefault();
  const name = document.getElementById('materialDbName').value.trim();
  const category = document.getElementById('materialDbCategory').value;
  const unit = document.getElementById('materialDbUnit').value.trim();
  const department = document.getElementById('materialDbDept').value;

  if (!name || !category) {
    showToast('请填写完整信息', 'error');
    return;
  }

  if (editingMaterialName) {
    // 编辑模式：更新材料库，并把改动同步到所有同名历史价格记录
    const oldName = editingMaterialName;
    const idx = materials.findIndex(m => m.name === oldName);
    if (idx >= 0) {
      materials[idx] = { name, category, unit, department };
    }
    const synced = propagateMaterialToRecords(oldName, { name, category, unit, department });
    editingMaterialName = null;
    if (synced > 0) {
      saveData(records); // 历史记录变更需落盘并触发云端同步
      showToast(`已更新材料，并同步 ${synced} 条历史记录`, 'success');
    } else {
      showToast('已更新材料', 'success');
    }
  } else {
    // 新增模式
    if (materials.some(m => m.name === name)) {
      showToast('该材料已存在', 'error');
      return;
    }
    materials.push({ name, category, unit, department });
    showToast('材料已添加', 'success');
  }

  saveMaterialDB(materials);
  resetMaterialForm();
  renderMaterials();
  refreshAll(); // 刷新全局联动
}

// 使用部门（单选下拉，与「所属分类」控件一致）
function setMaterialDept(val) {
  document.getElementById('materialDbDept').value = val || '';
}

// 兼容读取：优先新字段 department（字符串），旧数据 departments 数组取第一个
function getMaterialDept(m) {
  if (m.department) return m.department;
  if (Array.isArray(m.departments) && m.departments.length) return m.departments.join('、');
  return '';
}

function resetMaterialForm() {
  document.getElementById('materialForm').reset();
  editingMaterialName = null;
  document.getElementById('materialFormTitle').textContent = '新增材料';
  document.getElementById('materialSubmitBtn').textContent = '💾 保存';
  document.getElementById('materialSubmitBtn').classList.remove('btn-warning');
  document.getElementById('materialFormHint').textContent = '';
  const del = document.getElementById('deleteMaterialBtn');
  if (del) del.style.display = 'none';
}

function editMaterial(name) {
  const m = materials.find(x => x.name === name);
  if (!m) return;
  editingMaterialName = name;
  document.getElementById('materialDbName').value = m.name;
  document.getElementById('materialDbCategory').value = m.category;
  document.getElementById('materialDbUnit').value = m.unit || '';
  setMaterialDept(m.department || (Array.isArray(m.departments) ? m.departments[0] : ''));
  document.getElementById('materialFormTitle').textContent = '编辑材料';
  document.getElementById('materialSubmitBtn').textContent = '✏️ 更新';
  document.getElementById('materialSubmitBtn').classList.add('btn-warning');
  const unitTxt = m.unit ? `· 单位 ${m.unit}` : '';
  document.getElementById('materialFormHint').textContent = `正在编辑「${m.name}」· 分类 ${m.category}${unitTxt}（修改后点「更新」，或点「清空」取消）`;
  document.getElementById('materialFormHint').style.color = '#d97706';
  const del = document.getElementById('deleteMaterialBtn');
  if (del) del.style.display = '';
  window.scrollTo({ top: document.getElementById('materialForm').offsetTop - 80, behavior: 'smooth' });
}

function deleteMaterial(name) {
  if (!confirm(`确认删除材料「${name}」？\n（仅删除材料库定义，不影响已有的价格记录）`)) return;
  materials = materials.filter(m => m.name !== name);
  saveMaterialDB(materials);
  showToast('已删除', 'success');
  renderMaterials();
  refreshAll();
}

// 删除按钮已收进「新增/编辑材料」面板：删除当前正在编辑的材料定义
function deleteCurrentMaterial() {
  if (!editingMaterialName) return;
  const name = editingMaterialName;
  deleteMaterial(name);
  if (!materials.some(m => m.name === name)) resetMaterialForm();
}

// 快速将未归类材料添加到库
function quickAddMaterial(name) {
  // 取该材料价格记录中出现最多的计量单位作为预填值
  const unitCount = {};
  records.forEach(r => {
    if (r.materialName === name && r.unit) {
      unitCount[r.unit] = (unitCount[r.unit] || 0) + 1;
    }
  });
  const topUnit = Object.entries(unitCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  document.getElementById('materialDbName').value = name;
  document.getElementById('materialDbCategory').value = '';
  document.getElementById('materialDbUnit').value = topUnit;
  setMaterialDept('');
  editingMaterialName = null;
  document.getElementById('materialFormTitle').textContent = '新增材料';
  document.getElementById('materialSubmitBtn').textContent = '💾 保存';
  document.getElementById('materialSubmitBtn').classList.remove('btn-warning');
  document.getElementById('materialFormHint').textContent = `为「${name}」选择分类后保存${topUnit ? `（已预填单位：${topUnit}）` : ''}`;
  window.scrollTo({ top: document.getElementById('materialForm').offsetTop - 80, behavior: 'smooth' });
}

// ===== 数据总览：材料-分类-计量单位 联动 =====
function onMaterialFilterChange() {
  const material = document.getElementById('filterMaterial').value;
  const categorySel = document.getElementById('filterCategory');
  const unitReadout = document.getElementById('materialUnitReadout');
  const supplierSel = document.getElementById('filterSupplier');

  if (material) {
    // 根据材料自动联动的分类
    const m = materials.find(x => x.name === material);
    if (m && m.category) {
      categorySel.value = m.category;
    }
    // 联动显示该材料在材料库中的标准计量单位
    if (m && m.unit) {
      unitReadout.textContent = '📐 标准单位：' + m.unit;
      unitReadout.classList.remove('filter-unit-readout-warn');
    } else {
      unitReadout.textContent = '📐 单位：未定义';
      unitReadout.classList.add('filter-unit-readout-warn');
    }
    unitReadout.style.display = '';
    // 联动供应商下拉：只显示供应过该材料的供应商
    const relatedSuppliers = [...new Set(
      records.filter(r => r.materialName === material).map(r => (r.supplier || '').trim()).filter(Boolean)
    )].sort();
    const currentSupplier = supplierSel.value;
    supplierSel.innerHTML = '<option value="">全部供应商</option>' +
      relatedSuppliers.map(n => `<option value="${esc(n)}" ${n === currentSupplier ? 'selected' : ''}>${esc(n)}</option>`).join('');
  } else {
    unitReadout.textContent = '';
    unitReadout.style.display = 'none';
    unitReadout.classList.remove('filter-unit-readout-warn');
    // 恢复全部供应商
    refreshSupplierFilter();
  }
  renderTable();
}

function onCategoryFilterChange() {
  const category = document.getElementById('filterCategory').value;
  refreshMaterialFilter(category); // 根据分类过滤材料下拉
  // 分类变化时，同步刷新供应商下拉（只保留该分类下材料关联的供应商）
  refreshSupplierFilter(category ? null : '', category || null);
  renderTable();
}

// 数据总览：供应商筛选变化时联动原材料下拉
function onSupplierFilterChange() {
  const supplier = document.getElementById('filterSupplier').value;
  const materialSel = document.getElementById('filterMaterial');

  if (supplier) {
    // 只显示该供应商供应过的原材料
    const relatedMaterials = [...new Set(
      records.filter(r => (r.supplier || '') === supplier).map(r => r.materialName)
    )].sort();
    const current = materialSel.value;
    materialSel.innerHTML = '<option value="">全部原材料</option>' +
      relatedMaterials.map(n => `<option value="${esc(n)}" ${n === current ? 'selected' : ''}>${esc(n)}</option>`).join('');
  } else {
    // 恢复全部原材料
    refreshMaterialFilter(document.getElementById('filterCategory').value);
  }
  renderTable();
}

// ===== 录入表单：材料名称输入时自动填充分类与计量单位 =====
function onMaterialNameInput() {
  const name = document.getElementById('materialName').value.trim();
  if (!name) {
    refreshSupplierList(); // 材料清空 → 恢复显示供应商库全部
    return;
  }
  const m = materials.find(x => x.name === name);
  if (m && m.category) {
    document.getElementById('category').value = m.category;
    showToast(`已自动填充分类：${m.category}`, 'success');
  }
  if (m && m.unit) {
    ensureUnitOption(m.unit);
  }
  // 供应商与材料勾稽联动：只保留供应过该材料的供应商
  refreshSupplierList();
  // 非新供应商时，定价时间默认取上次供货时间
  pricingDateTouched = false;
  applyPricingDateDefault();
}

// ===== 供应商库 =====
function renderSuppliers() {
  const kw = (document.getElementById('supplierSearch')?.value || '').trim().toLowerCase();

  // 按供应商聚合
  const map = {};
  records.forEach(r => {
    const s = (r.supplier || '').trim();
    if (!s) return; // 无供应商名的不纳入供应商库
    if (kw && !s.toLowerCase().includes(kw)) return;
    if (!map[s]) {
      map[s] = { name: s, materials: new Set(), records: [], totalAmount: 0, dates: [] };
    }
    const g = map[s];
    g.materials.add(r.materialName);
    g.records.push(r);
    g.totalAmount += (r.totalAmount || 0);
    g.dates.push(r.pricingDate);
  });

  let list = Object.values(map).map(g => ({
    name: g.name,
    recordCount: g.records.length,
    totalAmount: g.totalAmount,
    lastDate: g.dates.length ? g.dates.reduce((a, b) => a > b ? a : b) : ''
  }));

  // 排序
  list.sort((a, b) => {
    let va = a[supplierSortField] ?? '';
    let vb = b[supplierSortField] ?? '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return supplierSortAsc ? -1 : 1;
    if (va > vb) return supplierSortAsc ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('supplierBody');
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state"><div class="emoji">🏢</div>${kw ? '未找到匹配的供应商' : '暂无供应商数据（录入时填写"供应商"字段后会出现在这里）'}</td></tr>`;
    document.getElementById('supplierFooter').textContent = '';
    document.getElementById('supplierSummary').innerHTML = '';
    return;
  }

  tbody.innerHTML = list.map(s => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td>${s.recordCount}</td>
      <td>${s.lastDate || '—'}</td>
      <td>${fmtNum(s.totalAmount)}</td>
      <td>
        <button class="btn-link" onclick="filterBySupplier('${esc(s.name)}')">查看明细</button>
      </td>
    </tr>
  `).join('');

  // 汇总卡片
  const totalSuppliers = list.length;
  const totalAmount = list.reduce((s, x) => s + x.totalAmount, 0);
  const top = list.reduce((a, b) => a.totalAmount > b.totalAmount ? a : b);
  document.getElementById('supplierSummary').innerHTML = `
    <div class="stat-card">
      <div class="icon">🏢</div>
      <div class="stat-label">供应商总数</div>
      <div class="stat-value">${totalSuppliers}</div>
    </div>
    <div class="stat-card">
      <div class="icon">💰</div>
      <div class="stat-label">累计采购金额</div>
      <div class="stat-value">${fmtNum(totalAmount)}</div>
      <div class="stat-sub">元</div>
    </div>
    <div class="stat-card">
      <div class="icon">🏆</div>
      <div class="stat-label">采购额最高供应商</div>
      <div class="stat-value" style="font-size:18px">${esc(top.name)}</div>
      <div class="stat-sub">${fmtNum(top.totalAmount)} 元</div>
    </div>
  `;

  document.getElementById('supplierFooter').textContent =
    `共 ${totalSuppliers} 家供应商 | 累计采购金额：${fmtNum(totalAmount)} 元`;
}

function sortSuppliers(field) {
  if (supplierSortField === field) {
    supplierSortAsc = !supplierSortAsc;
  } else {
    supplierSortField = field;
    supplierSortAsc = true;
  }
  renderSuppliers();
}

// 点击"查看明细"：按该供应商筛选数据总览
function filterBySupplier(name) {
  document.getElementById('filterSupplier').value = name || '';
  document.getElementById('searchInput').value = '';
  document.getElementById('filterMaterial').value = '';
  document.getElementById('filterCategory').value = '';
  document.getElementById('filterMonth').value = '';
  switchTab('list');
  renderTable();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== 趋势分析 =====
function initTrendTab() {
  const sel = document.getElementById('trendMaterial');
  const names = [...new Set(records.map(r => r.materialName))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">请选择原材料</option>' +
    names.map(n => `<option value="${esc(n)}" ${n === current ? 'selected' : ''}>${esc(n)}</option>`).join('');

  // 多选checkbox
  const cbWrap = document.getElementById('multiMaterialCheckboxes');
  cbWrap.innerHTML = names.map(n =>
    `<label><input type="checkbox" value="${esc(n)}" onchange="renderCompare()"> ${esc(n)}</label>`
  ).join('');
}

function renderTrend() {
  const multiVisible = document.getElementById('multiCompare').style.display !== 'none';
  if (multiVisible) {
    renderCompare();
    return;
  }

  const materialName = document.getElementById('trendMaterial').value;
  const ctx = document.getElementById('trendChart');

  if (trendChartInstance) { trendChartInstance.destroy(); trendChartInstance = null; }
  document.getElementById('trendStats').innerHTML = '';
  document.getElementById('trendDetail').innerHTML = '';

  if (!materialName) {
    ctx.parentElement.innerHTML = '<div class="empty-state"><div class="emoji">📈</div>请在右上角选择原材料查看趋势</div>';
    return;
  }

  // 恢复canvas
  if (!ctx || ctx.tagName !== 'CANVAS') {
    document.querySelector('#singleTrend .chart-container').innerHTML = '<canvas id="trendChart"></canvas>';
  }

  const materialRecords = records
    .filter(r => r.materialName === materialName)
    .sort((a, b) => a.pricingDate.localeCompare(b.pricingDate));

  if (materialRecords.length === 0) {
    document.querySelector('#singleTrend .chart-container').innerHTML =
      '<div class="empty-state"><div class="emoji">📭</div>该材料暂无数据</div>';
    return;
  }

  drawTrendChart(materialName, materialRecords);
  renderTrendStats(materialRecords);
  renderTrendDetail(materialRecords);
}

function drawTrendChart(name, data) {
  const canvas = document.getElementById('trendChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const labels = data.map(r => r.pricingDate);
  const prices = data.map(r => r.price);

  // 环比数据
  const momData = data.map((r, i) => {
    if (i === 0) return null;
    const prev = data[i - 1].price;
    if (prev === 0) return null;
    return +(((r.price - prev) / prev) * 100).toFixed(2);
  });

  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '单价(元)',
          data: prices,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 5,
          pointHoverRadius: 7,
          yAxisID: 'y'
        },
        {
          label: '环比(%)',
          data: momData,
          borderColor: '#d97706',
          backgroundColor: 'rgba(217,119,6,0.08)',
          borderWidth: 2,
          fill: false,
          tension: 0.2,
          pointRadius: 4,
          pointHoverRadius: 6,
          yAxisID: 'y1',
          borderDash: [5, 5]
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: `${name} - 价格波动趋势`, font: { size: 16, weight: 'bold' } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.dataset.yAxisID === 'y1') {
                const v = ctx.parsed.y;
                return `环比: ${v >= 0 ? '↑' : '↓'}${Math.abs(v).toFixed(2)}%${Math.abs(v) >= ALERT_THRESHOLD ? ' ⚠️异常' : ''}`;
              }
              return `单价: ${fmtPrice(ctx.parsed.y)} 元`;
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: '定价时间' }
        },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: '单价(元)' },
          beginAtZero: false
        },
        y1: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: '环比(%)' },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}

function renderTrendStats(data) {
  const prices = data.map(r => r.price);
  const latest = data[data.length - 1];
  const first = data[0];
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const totalPct = first.price ? ((latest.price - first.price) / first.price * 100) : 0;
  const std = Math.sqrt(prices.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / prices.length);
  const volatility = avg ? (std / avg * 100) : 0;
  const totalAmount = data.reduce((s, r) => s + r.totalAmount, 0);

  const momClass = totalPct >= 0 ? 'up' : 'down';

  document.getElementById('trendStats').innerHTML = `
    <div class="stat-box"><div class="label">最新单价</div><div class="value">${fmtPrice(latest.price)} 元</div></div>
    <div class="stat-box"><div class="label">期初单价</div><div class="value">${fmtPrice(first.price)} 元</div></div>
    <div class="stat-box"><div class="label">累计涨跌</div><div class="value ${momClass}">${totalPct >= 0 ? '↑' : '↓'}${Math.abs(totalPct).toFixed(1)}%</div></div>
    <div class="stat-box"><div class="label">平均价</div><div class="value">${fmtPrice(avg)} 元</div></div>
    <div class="stat-box"><div class="label">最高价</div><div class="value">${fmtPrice(max)} 元</div></div>
    <div class="stat-box"><div class="label">最低价</div><div class="value">${fmtPrice(min)} 元</div></div>
    <div class="stat-box"><div class="label">波动率</div><div class="value">${volatility.toFixed(1)}%</div></div>
    <div class="stat-box"><div class="label">累计采购额</div><div class="value">${fmtNum(totalAmount)} 元</div></div>
  `;
}

function renderTrendDetail(data) {
  const rows = data.map((r, i) => {
    let momHtml = '<span class="mom-flat">—</span>';
    if (i > 0) {
      const prev = data[i - 1].price;
      if (prev > 0) {
        const pct = ((r.price - prev) / prev * 100);
        const cls = Math.abs(pct) >= ALERT_THRESHOLD ? 'mom-up mom-alert' : (pct >= 0 ? 'mom-up' : 'mom-down');
        momHtml = `<span class="${cls}">${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(1)}%</span>`;
      }
    }
    return `<tr>
      <td>${r.pricingDate}</td>
      <td>${esc(r.supplyDate) || '—'}</td>
      <td>${fmtPrice(r.price)}</td>
      <td>${fmtNum(r.quantity)} ${r.unit}</td>
      <td>${fmtNum(r.totalAmount)}</td>
      <td>${momHtml}</td>
      <td>${esc(r.supplier) || '—'}</td>
      <td>${esc(r.remark) || '—'}</td>
    </tr>`;
  }).reverse().join('');

  document.getElementById('trendDetail').innerHTML = `
    <table class="data-table" style="border:1px solid var(--border); border-radius:6px;">
      <thead><tr>
        <th>定价时间</th><th>供货时间</th><th>单价(元)</th><th>数量</th><th>金额(元)</th><th>环比</th><th>供应商</th><th>备注</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ===== 多材料对比 =====
function toggleMultiCompare() {
  const single = document.getElementById('singleTrend');
  const multi = document.getElementById('multiCompare');
  const btn = document.getElementById('multiCompareBtn');
  if (multi.style.display === 'none') {
    multi.style.display = 'block';
    single.style.display = 'none';
    btn.textContent = '单材料趋势';
    renderCompare();
  } else {
    multi.style.display = 'none';
    single.style.display = 'block';
    btn.textContent = '多材料对比';
    renderTrend();
  }
}

function renderCompare() {
  const checked = [...document.querySelectorAll('#multiMaterialCheckboxes input:checked')].slice(0, 5).map(cb => cb.value);

  if (compareChartInstance) { compareChartInstance.destroy(); compareChartInstance = null; }
  document.getElementById('compareTableWrap').innerHTML = '';

  if (checked.length === 0) {
    return;
  }

  const ctx = document.getElementById('compareChart').getContext('2d');
  const colors = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed'];

  // 收集所有月份
  const allMonths = new Set();
  const series = checked.map((name, i) => {
    const data = records.filter(r => r.materialName === name).sort((a, b) => a.pricingDate.localeCompare(b.pricingDate));
    data.forEach(r => allMonths.add(r.pricingDate));
    return { name, color: colors[i], data };
  });

  const sortedMonths = [...allMonths].sort();

  const datasets = series.map(s => {
    const map = {};
    s.data.forEach(r => { map[r.pricingDate] = r.price; });
    return {
      label: s.name,
      data: sortedMonths.map(m => map[m] || null),
      borderColor: s.color,
      backgroundColor: s.color + '20',
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 4,
      fill: false
    };
  });

  compareChartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: sortedMonths, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: '多材料价格对比', font: { size: 16, weight: 'bold' } }
      },
      scales: {
        y: { title: { display: true, text: '单价(元)' }, beginAtZero: false }
      }
    }
  });

  // 对比表
  const tableRows = series.map(s => {
    const prices = s.data.map(r => r.price);
    if (prices.length === 0) return '';
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const first = s.data[0].price;
    const last = s.data[s.data.length - 1].price;
    const pct = first ? ((last - first) / first * 100) : 0;
    const cls = pct >= 0 ? 'mom-up' : 'mom-down';
    return `<tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td>${fmtPrice(last)}</td>
      <td>${fmtPrice(first)}</td>
      <td class="${cls}">${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(1)}%</td>
      <td>${fmtPrice(avg)}</td>
      <td>${fmtPrice(Math.max(...prices))}</td>
      <td>${fmtPrice(Math.min(...prices))}</td>
    </tr>`;
  }).join('');

  document.getElementById('compareTableWrap').innerHTML = `
    <table class="data-table" style="border:1px solid var(--border); border-radius:6px;">
      <thead><tr>
        <th>原材料</th><th>最新价</th><th>期初价</th><th>累计变动</th><th>均价</th><th>最高价</th><th>最低价</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
}

// ===== 统计概览 =====
function renderStats() {
  const totalRecords = records.length;
  const totalAmount = records.reduce((s, r) => s + r.totalAmount, 0);
  const materialCount = new Set(records.map(r => r.materialName)).size;

  // 异常条数
  let alertCount = 0;
  const byMaterial = {};
  records.forEach(r => {
    if (!byMaterial[r.materialName]) byMaterial[r.materialName] = [];
    byMaterial[r.materialName].push(r);
  });
  Object.values(byMaterial).forEach(arr => {
    arr.sort((a, b) => a.pricingDate.localeCompare(b.pricingDate));
    for (let i = 1; i < arr.length; i++) {
      const mom = calcMoM(arr[i], arr);
      if (mom && mom.alert) alertCount++;
    }
  });

  // 最新月份
  const latestMonth = records.length > 0
    ? records.map(r => r.pricingDate.slice(0, 7)).sort().reverse()[0]
    : '—';

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card">
      <div class="icon">📋</div>
      <div class="stat-label">总记录数</div>
      <div class="stat-value">${totalRecords}</div>
      <div class="stat-sub">${materialCount} 种原材料</div>
    </div>
    <div class="stat-card">
      <div class="icon">💰</div>
      <div class="stat-label">累计采购总额</div>
      <div class="stat-value">${fmtNum(totalAmount)}</div>
      <div class="stat-sub">元</div>
    </div>
    <div class="stat-card">
      <div class="icon">📅</div>
      <div class="stat-label">最新数据月份</div>
      <div class="stat-value">${latestMonth}</div>
    </div>
    <div class="stat-card">
      <div class="icon">⚠️</div>
      <div class="stat-label">异常波动条数</div>
      <div class="stat-value" style="color:${alertCount > 0 ? 'var(--danger)' : 'var(--success)'}">${alertCount}</div>
      <div class="stat-sub">环比≥±${ALERT_THRESHOLD}%</div>
    </div>
  `;

  // 汇总表
  renderSummaryTable(byMaterial);
  // 采购金额趋势
  renderAmountChart();
}

function renderSummaryTable(byMaterial) {
  const tbody = document.getElementById('summaryBody');
  const rows = Object.entries(byMaterial).map(([name, arr]) => {
    arr.sort((a, b) => a.pricingDate.localeCompare(b.pricingDate));
    const prices = arr.map(r => r.price);
    const latest = arr[arr.length - 1];
    const prev = arr.length >= 2 ? arr[arr.length - 2] : null;
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const totalAmt = arr.reduce((s, r) => s + r.totalAmount, 0);

    let momHtml = '<span class="mom-flat">—</span>';
    if (prev && prev.price > 0) {
      const pct = ((latest.price - prev.price) / prev.price * 100);
      const cls = Math.abs(pct) >= ALERT_THRESHOLD ? 'mom-up mom-alert' : (pct >= 0 ? 'mom-up' : 'mom-down');
      momHtml = `<span class="${cls}">${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(1)}%</span>`;
    }

    const std = Math.sqrt(prices.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / prices.length);
    const volatility = avg ? (std / avg * 100) : 0;

    return `<tr>
      <td><strong>${esc(name)}</strong></td>
      <td>${latest.category}</td>
      <td>${arr.length}</td>
      <td>${fmtPrice(latest.price)}</td>
      <td>${prev ? fmtPrice(prev.price) : '—'}</td>
      <td>${momHtml}</td>
      <td>${fmtPrice(avg)}</td>
      <td>${fmtPrice(Math.max(...prices))}</td>
      <td>${fmtPrice(Math.min(...prices))}</td>
      <td>${volatility.toFixed(1)}%</td>
      <td>${fmtNum(totalAmt)}</td>
    </tr>`;
  }).join('');

  tbody.innerHTML = rows || '<tr><td colspan="11" class="empty-state">暂无数据</td></tr>';
}

function renderAmountChart() {
  const ctx = document.getElementById('amountChart').getContext('2d');
  if (amountChartInstance) { amountChartInstance.destroy(); amountChartInstance = null; }

  // 按月汇总
  const byMonth = {};
  records.forEach(r => {
    const m = r.pricingDate.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = 0;
    byMonth[m] += r.totalAmount;
  });

  const sorted = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  const labels = sorted.map(e => e[0]);
  const amounts = sorted.map(e => e[1]);

  amountChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '采购金额(元)',
        data: amounts,
        backgroundColor: 'rgba(37,99,235,0.7)',
        borderColor: '#2563eb',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: '月度采购金额', font: { size: 16, weight: 'bold' } },
        legend: { display: false }
      },
      scales: {
        y: {
          title: { display: true, text: '金额(元)' },
          beginAtZero: true
        }
      }
    }
  });
}

// ===== 导出/导入 =====
function exportCSV() {
  if (records.length === 0) { showToast('暂无数据可导出', 'error'); return; }

  const headers = ['定价时间', '供货时间', '原材料名称', '分类', '单价', '数量', '单位', '金额', '供应商', '备注'];
  const rows = records.map(r => [
    r.pricingDate, r.supplyDate || '', r.materialName, r.category, r.price, r.quantity, r.unit, r.totalAmount, r.supplier, r.remark
  ]);

  const bom = '\uFEFF'; // UTF-8 BOM for Excel
  const csv = bom + [headers, ...rows].map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');

  downloadFile(csv, '原材料价格数据.csv', 'text/csv;charset=utf-8');
  showToast('CSV已导出', 'success');
}

function exportJSON() {
  const data = {
    exportDate: new Date().toISOString(),
    records: records,
    materials: materials
  };
  downloadFile(JSON.stringify(data, null, 2), '原材料价格数据库备份.json', 'application/json');
  showToast('备份文件已下载（含材料库）', 'success');
}

function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const data = JSON.parse(evt.target.result);
      const imported = Array.isArray(data) ? data : (data.records || []);
      const importedMaterials = data.materials || [];
      if (!Array.isArray(imported) || imported.length === 0) throw new Error('格式错误');
      const norm = imported.map(s => ({
        ...s,
        id: s.id || (Date.now().toString() + Math.random().toString(36).slice(2, 6)),
        totalAmount: +(s.price * (s.quantity || 0)).toFixed(2),
        createdAt: s.createdAt || new Date().toISOString()
      }));
      const replace = confirm(
        `即将导入 ${norm.length} 条成本数据` +
        (importedMaterials.length > 0 ? ` + ${importedMaterials.length} 条材料定义` : '') +
        `。\n\n` +
        `点【确定】= 清空现有数据并导入（推荐：替换示例数据）\n` +
        `点【取消】= 与现有数据合并`
      );
      records = replace ? norm : [...records, ...norm];
      saveData(records);
      // 导入材料库（合并模式：不覆盖已有的）
      if (importedMaterials.length > 0) {
        const existingNames = new Set(materials.map(m => m.name));
        const newMaterials = importedMaterials.filter(m => !existingNames.has(m.name));
        materials = [...materials, ...newMaterials];
        saveMaterialDB(materials);
      }
      showToast(`已导入 ${norm.length} 条记录${importedMaterials.length > 0 ? ' + ' + importedMaterials.length + ' 条材料定义' : ''}${replace ? '（已替换）' : '（已合并）'}`, 'success');
      refreshAll();
    } catch (err) {
      showToast('文件格式错误', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type: type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 工具函数 =====
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 单价专用：最多保留 3 位小数（低价耗材如 0.125 元/个 需要第 3 位）
// 仍保留至少 2 位，维持原有表格对齐与观感
function fmtPrice(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 刷新 =====
function refreshAll() {
  refreshMaterialList();
  refreshSupplierList();
  refreshCategoryFilter();
  const categoryFilter = document.getElementById('filterCategory').value;
  refreshMaterialFilter(categoryFilter);
  refreshSupplierFilter();
  renderTable();
  if (document.getElementById('tab-trend').classList.contains('active')) {
    initTrendTab();
    renderTrend();
  }
  if (document.getElementById('tab-stats').classList.contains('active')) {
    renderStats();
  }
  if (document.getElementById('tab-materials').classList.contains('active')) {
    renderMaterials();
  }
}

// 分类改名：旧「原材料」统一映射到「主材」（材料库与价格记录都改）
// 每次加载都执行（幂等：改完就没有「原材料」了），确保云端拉回的旧数据也能纠正
function migrateCategoryRename() {
  let changed = false;
  materials.forEach(m => { if (m.category === '原材料') { m.category = '主材'; changed = true; } });
  records.forEach(r => { if (r.category === '原材料') { r.category = '主材'; changed = true; } });
  if (changed) { saveMaterialDB(materials); saveData(records); }
}

// 把非标准分类统一归为「其它」（兼容旧数据/历史导出的数据）
// 有材料库时，按材料库定义纠正分类
function normalizeCategories() {
  let changed = false;
  records.forEach(r => {
    // 分类改名兼容：旧「原材料」统一映射为「主材」（也覆盖云端拉回的旧数据）
    if (r.category === '原材料') { r.category = '主材'; changed = true; }
    // 先标准化未知分类
    if (!isKnownCategory(r.category)) {
      r.category = '其它';
      changed = true;
    }
    // 有材料库定义时，强制同步为材料库中的分类与标准单位
    const dbMat = materials.find(m => m.name === r.materialName);
    if (dbMat) {
      if (dbMat.category && r.category !== dbMat.category) {
        r.category = dbMat.category;
        changed = true;
      }
      // 材料库有标准单位才覆盖，避免清空历史记录的单位
      if (dbMat.unit && r.unit !== dbMat.unit) {
        r.unit = dbMat.unit;
        changed = true;
      }
    }
  });
  if (changed) saveData(records);
}

// 自动同步：从价格记录中提取材料-分类关系，补充到材料库
function syncMaterialsFromRecords() {
  if (records.length === 0) return;
  let changed = false;
  const dbMap = {};
  materials.forEach(m => { dbMap[m.name] = m.category; });

  records.forEach(r => {
    const name = (r.materialName || '').trim();
    const category = r.category;
    if (!name || !isKnownCategory(category)) return;
    if (!dbMap[name]) {
      // 该材料所有记录的计量单位一致时，自动带入标准单位
      const units = [...new Set(
        records.filter(x => x.materialName === name).map(x => x.unit).filter(Boolean)
      )];
      const unit = units.length === 1 ? units[0] : '';
      materials.push({ name, category, unit });
      dbMap[name] = category;
      changed = true;
    }
  });

  if (changed) {
    saveMaterialDB(materials);
    showToast('已从价格记录自动同步材料库', 'success');
  }
}

function refreshCategoryFilter() {
  const sel = document.getElementById('filterCategory');
  const current = sel.value;
  sel.innerHTML = '<option value="">全部分类</option>' +
    CATEGORIES.map(c => `<option value="${c}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

// 数据总览：原材料名称筛选下拉（支持按分类过滤）
function refreshMaterialFilter(categoryFilter) {
  const sel = document.getElementById('filterMaterial');
  const current = sel.value;
  let names;
  if (categoryFilter) {
    // 只显示该分类下的材料（材料库中定义的材料 + 该分类下已有的记录材料）
    const dbNames = materials.filter(m => m.category === categoryFilter).map(m => m.name);
    const recordNames = [...new Set(records.filter(r => r.category === categoryFilter).map(r => r.materialName))];
    names = [...new Set([...dbNames, ...recordNames])].sort();
  } else {
    names = [...new Set(records.map(r => r.materialName))].sort();
  }
  sel.innerHTML = '<option value="">全部原材料</option>' +
    names.map(n => `<option value="${esc(n)}" ${n === current ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

// 数据总览：供应商筛选下拉
// materialFilter: 只显示供应过该材料的供应商；categoryFilter: 只显示该分类下材料关联的供应商
function refreshSupplierFilter(materialFilter, categoryFilter) {
  const sel = document.getElementById('filterSupplier');
  const current = sel.value;
  let pool = records;
  if (materialFilter) {
    pool = pool.filter(r => r.materialName === materialFilter);
  }
  if (categoryFilter) {
    pool = pool.filter(r => r.category === categoryFilter);
  }
  const names = [...new Set(pool.map(r => (r.supplier || '').trim()).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部供应商</option>' +
    names.map(n => `<option value="${esc(n)}" ${n === current ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

// ===== 旧示例数据迁移（精准清除） =====
// 仅删除最初内置的 18 条虚构示例，绝不碰用户真实录入/导入的数据
const OLD_SAMPLE_FP = new Set([
  '冷轧钢板|宝钢|4500|2025-01-15|200',
  '冷轧钢板|宝钢|4650|2025-02-15|180',
  '冷轧钢板|宝钢|4400|2025-03-15|220',
  '冷轧钢板|宝钢|4200|2025-04-15|200',
  '冷轧钢板|宝钢|4350|2025-05-15|190',
  '冷轧钢板|宝钢|4500|2025-06-15|210',
  '铝锭|中铝|18500|2025-01-15|50',
  '铝锭|中铝|19200|2025-02-15|50',
  '铝锭|中铝|19800|2025-03-15|60',
  '铝锭|中铝|19500|2025-04-15|55',
  '铝锭|中铝|18900|2025-05-15|50',
  '铝锭|中铝|19300|2025-06-15|50',
  '聚乙烯(PE)|中石化|8200|2025-01-20|100',
  '聚乙烯(PE)|中石化|8350|2025-02-20|100',
  '聚乙烯(PE)|中石化|8100|2025-03-20|120',
  '聚乙烯(PE)|中石化|7900|2025-04-20|100',
  '聚乙烯(PE)|中石化|8050|2025-05-20|110',
  '聚乙烯(PE)|中石化|8200|2025-06-20|100'
]);

function fp(r) {
  return `${r.materialName}|${r.supplier || ''}|${r.price}|${r.pricingDate}|${r.quantity || 0}`;
}

function migrateOldSampleData() {
  if (localStorage.getItem('MIGRATE_SAMPLE_V1')) return;
  const before = records.length;
  records = records.filter(r => !OLD_SAMPLE_FP.has(fp(r)));
  const removed = before - records.length;
  if (removed > 0) {
    saveData(records);
    showToast(`已自动清除 ${removed} 条旧示例数据`, 'success');
  }
  localStorage.setItem('MIGRATE_SAMPLE_V1', '1');
}

// ===== 样例数据 =====
// 默认加载真实成本数据（来自《原材料价值工程.xlsx》），替换原示例数据
function loadSampleData() {
  if (records.length > 0) return;
  if (typeof SEED_DATA === 'undefined' || !SEED_DATA.length) return;
  records = SEED_DATA.map(s => ({
    ...s,
    id: s.id || (Date.now().toString() + Math.random().toString(36).slice(2, 6)),
    totalAmount: +(s.price * (s.quantity || 0)).toFixed(2),
    createdAt: s.createdAt || new Date().toISOString()
  }));
  saveData(records);
  refreshAll();
}

// ===== PWA 安装到本地 =====
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = '';
});

window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'none';
  deferredInstallPrompt = null;
  showToast('已安装到本地 🎉', 'success');
});

function detectBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('chrome') || ua.includes('crios')) return 'chrome';
  if (ua.includes('safari') && !ua.includes('chrome')) return 'safari';
  if (ua.includes('firefox')) return 'firefox';
  return 'other';
}

function showInstall() {
  const browser = detectBrowser();
  const modal = document.getElementById('installModal');
  const gSafari = document.getElementById('installGuideSafari');
  const gChrome = document.getElementById('installGuideChrome');
  const gOther = document.getElementById('installGuideOther');
  const confirmBtn = document.getElementById('installConfirmBtn');

  gSafari.style.display = 'none';
  gChrome.style.display = 'none';
  gOther.style.display = 'none';
  confirmBtn.style.display = 'none';

  if (browser === 'safari') {
    gSafari.style.display = 'block';
  } else if ((browser === 'chrome' || browser === 'edge') && deferredInstallPrompt) {
    gChrome.style.display = 'block';
    confirmBtn.style.display = '';
  } else if (deferredInstallPrompt) {
    gChrome.style.display = 'block';
    confirmBtn.style.display = '';
  } else {
    gOther.style.display = 'block';
  }

  modal.style.display = 'flex';
}

function triggerInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => {
      deferredInstallPrompt = null;
      closeInstallModal();
    });
  } else {
    closeInstallModal();
  }
}

function closeInstallModal() {
  document.getElementById('installModal').style.display = 'none';
}

// ===== Service Worker 注册（离线兜底，网络优先） =====
// 新 sw.js 采用「网络优先」策略：在线时永远拿最新代码，
// 只有断网才用缓存兜底。因此不再需要「强制刷新」，也不会有刷新死循环。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js?v=' + APP_VERSION)
      .then((reg) => { reg.update().catch(() => {}); })
      .catch(() => { /* 离线能力不可用不影响使用 */ });
  });
}

// 检查更新：先让 SW 去拉最新版，再普通重载一次（不做缓存清理、不做跳板跳转）
function checkUpdate() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistration()
      .then((r) => (r ? r.update() : null))
      .catch(() => {});
  }
  setTimeout(() => window.location.reload(), 200);
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  setDefaultDate();
  migrateCategoryRename(); // 旧「原材料」分类统一改「主材」（幂等）
  migrateOldSampleData();
  loadSampleData();
  normalizeCategories();
  syncMaterialsFromRecords(); // 自动同步材料库
  refreshAll();
  registerServiceWorker();
  const vEl = document.getElementById('appVersion');
  if (vEl) vEl.textContent = 'v' + APP_VERSION;

  // 联网同步：还原开关状态并启动（本地优先、无登录、board 串多端共享）
  const syncChk = document.getElementById('syncEnabled');
  if (syncChk) syncChk.checked = SYNCSB.enabled;
  startSync();

  // 页脚「数据管理」菜单：点击面板内选项或点击外部时自动收起
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.footer-menu[open]').forEach((d) => {
      if (!d.contains(e.target) || e.target.closest('.footer-menu-panel')) d.open = false;
    });
  });
});

/* =========================================================================
 *  Supabase 建表语句（开启「联网同步」前，在 Supabase 后台 SQL 编辑器执行一次）
 *  项目：gcwehwqcccmjxrqtolev.supabase.co（复用工作台同一项目，anon key 已内置）
 *  说明：本 app 用「本地优先 + board 串共享 + 无登录」模型，anon key 直接读写该行。
 *        Supabase 新建表默认开启 RLS 会拦截 anon，所以这里关闭 RLS（board 串即口令）。
 * =========================================================================
create table if not exists rawmat_state (
  id          text primary key,
  data        jsonb,
  updated_at  timestamptz
);

-- 关闭行级安全，使内置 anon key 可读写（board 串相当于共享口令，保证多端同步）
alter table rawmat_state disable row level security;
 *
 * ========================================================================= */
