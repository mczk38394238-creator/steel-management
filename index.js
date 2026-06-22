const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const WebSocket = require('ws');
global.WebSocket = WebSocket;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== 物件 =====

app.get('/api/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('projects').select('*').eq('status', 'active').order('id', { ascending: true });
  if (error) { console.error('GET /api/projects:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data || []);
});

app.get('/api/projects/trash', async (req, res) => {
  const { data, error } = await supabase
    .from('projects').select('*').eq('status', 'deleted').order('id', { ascending: true });
  if (error) { console.error('GET /api/projects/trash:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data || []);
});

app.post('/api/projects', async (req, res) => {
  const { data, error } = await supabase.from('projects').insert([req.body]).select();
  if (error) { console.error('POST /api/projects:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data && data[0] ? data[0] : { success: true });
});

app.put('/api/projects/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  const { data, error } = await supabase.from('projects').update(req.body).eq('id', id).select();
  if (error) { console.error('PUT /api/projects/' + id + ':', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data && data[0] ? data[0] : { success: true });
});

// 物件に紐づく全関連テーブルを削除するヘルパー
// 将来テーブルが増えたら RELATED_TABLES に追加するだけでOK
const RELATED_TABLES = [
  'order_items',
  // 'arrival_records',   // 入荷管理（追加予定）
  // 'mill_sheets',       // ミルシート（追加予定）
  // 'invoices',          // 請求（追加予定）
  // 'connections',       // 取合（追加予定）
  // 'inventory',         // 在庫（追加予定）
];

async function deleteProjectCascade(projectId) {
  for (const table of RELATED_TABLES) {
    const { error } = await supabase.from(table).delete().eq('project_id', projectId);
    if (error) throw new Error(table + ' の削除失敗: ' + error.message);
  }
}

app.delete('/api/projects/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  try {
    await deleteProjectCascade(id);
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/projects/' + id + ':', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== 明細 =====

app.get('/api/order-items/:projectId', async (req, res) => {
  const { data, error } = await supabase
    .from('order_items').select('*').eq('project_id', req.params.projectId).order('seq_no', { ascending: true });
  if (error) { console.error('GET /api/order-items:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data || []);
});

app.post('/api/order-items', async (req, res) => {
  const { data, error } = await supabase.from('order_items').insert([req.body]).select();
  if (error) { console.error('POST /api/order-items:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data && data[0] ? data[0] : { success: true });
});

app.put('/api/order-items/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  const { data, error } = await supabase.from('order_items').update(req.body).eq('id', id).select();
  if (error) { console.error('PUT /api/order-items/' + id + ':', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data && data[0] ? data[0] : { success: true });
});

app.delete('/api/order-items/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  const { error } = await supabase.from('order_items').delete().eq('id', id);
  if (error) { console.error('DELETE /api/order-items/' + id + ':', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ success: true });
});

app.post('/api/order-items/bulk', async (req, res) => {
  const { project_id, items, mode } = req.body;
  if (mode === 'replace') {
    const { error: deleteError } = await supabase.from('order_items').delete().eq('project_id', project_id);
    if (deleteError) return res.status(500).json({ error: deleteError.message });
  }
  const rows = items.map(item => ({ ...item, project_id }));
  const { data, error } = await supabase.from('order_items').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: data.length });
});

// ===== 入荷管理 =====

// 契約Noで明細を横断検索する窓口（実績の直接登録で、対象の明細を探すときに使用）
app.get('/api/order-items/search-by-contract', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const { data, error } = await supabase
    .from('order_items')
    .select('*, projects(project_name)')
    .ilike('contract_no', '%' + q + '%')
    .order('id', { ascending: true })
    .limit(50);
  if (error) { console.error('GET /api/order-items/search-by-contract:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data || []);
});

// 予定（入荷管理）の行が無い場合に、実績だけを直接登録する窓口
// 内部的には入荷予定行を新しく1件作り、入荷日・本数をその場で入れて確定させる
// （入荷予定行を作ると、上のsyncScheduleToArrivalsにより実績（arrivals）にも自動で反映される）
app.post('/api/arrivals/direct', async (req, res) => {
  const { order_item_id, arrival_date, arrival_qty, delivery_note_no, notes } = req.body;
  if (!order_item_id || !arrival_date || arrival_qty === undefined || arrival_qty === null) {
    return res.status(400).json({ error: '明細・入荷日・入荷本数は必須です' });
  }
  try {
    const { data: item, error: itemError } = await supabase
      .from('order_items').select('*').eq('id', order_item_id).maybeSingle();
    if (itemError) throw new Error(itemError.message);
    if (!item) return res.status(404).json({ error: '対象の明細が見つかりません' });

    const carrier = await resolveCarrier(item.maker, item.contract_no);
    const { data: scheduleData, error: scheduleError } = await supabase
      .from('arrival_schedules')
      .insert([{
        order_item_id: item.id,
        contract_no: item.contract_no,
        shipping_company: carrier,
        arrival_date: arrival_date,
        arrival_qty: arrival_qty,
      }])
      .select();
    if (scheduleError) throw new Error(scheduleError.message);
    const scheduleRow = scheduleData[0];

    await syncScheduleToArrivals(scheduleRow);
    if (delivery_note_no || notes) {
      await supabase.from('arrivals')
        .update({ delivery_note_no: delivery_note_no || null, notes: notes || null })
        .eq('schedule_id', scheduleRow.id);
    }

    res.json({ success: true, schedule: scheduleRow });
  } catch (e) {
    console.error('POST /api/arrivals/direct:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 入荷予定を全件取得する窓口（全物件横断・発注明細と物件情報も一緒に取得）
app.get('/api/arrival-schedules', async (req, res) => {
  const { data, error } = await supabase
    .from('arrival_schedules')
    .select('*, order_items(*, projects(project_name))')
    .order('id', { ascending: true });
  if (error) { console.error('GET /api/arrival-schedules:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data || []);
});

// メーカー→運送会社の対応表を取得する窓口
app.get('/api/carriers-master', async (req, res) => {
  const { data, error } = await supabase
    .from('carriers_master').select('*').order('id', { ascending: true });
  if (error) { console.error('GET /api/carriers-master:', error.message); return res.status(500).json({ error: error.message }); }
  res.json(data || []);
});

// メーカー名・契約Noから運送会社を自動判定するヘルパー
async function resolveCarrier(maker, contractNo) {
  if (!maker) return null;
  // 東京製鉄は契約Noの末尾でミルが変わる特殊ルール
  if (maker.indexOf('東京製鉄') !== -1) {
    const c = contractNo || '';
    if (c.indexOf('宇') !== -1) return '宇都宮';
    if (c.indexOf('12号') !== -1) return '12号地';
    return null;
  }
  const { data, error } = await supabase
    .from('carriers_master').select('default_carrier').eq('maker_name', maker).maybeSingle();
  if (error || !data) return null;
  return data.default_carrier;
}

// 入荷予定（arrival_schedules）の1行を、実績（arrivals）に反映するヘルパー
// 入荷日・入荷本数の両方が入っている行だけを対象に、対応する実績行を作成・更新する
// すでに実績行がある場合（schedule_idで判定）は新規作成せず上書き更新する
async function syncScheduleToArrivals(scheduleRow) {
  if (!scheduleRow || !scheduleRow.arrival_date || scheduleRow.arrival_qty === null || scheduleRow.arrival_qty === undefined) {
    return;
  }
  try {
    const { data: oi } = await supabase
      .from('order_items').select('project_id').eq('id', scheduleRow.order_item_id).maybeSingle();
    const { data: existing } = await supabase
      .from('arrivals').select('id').eq('schedule_id', scheduleRow.id).maybeSingle();
    const payload = {
      order_item_id: scheduleRow.order_item_id,
      project_id: oi ? oi.project_id : null,
      arrival_date: scheduleRow.arrival_date,
      arrived_qty: scheduleRow.arrival_qty,
      schedule_id: scheduleRow.id,
    };
    if (existing) {
      await supabase.from('arrivals').update(payload).eq('id', existing.id);
    } else {
      await supabase.from('arrivals').insert([payload]);
    }
  } catch (e) {
    console.error('syncScheduleToArrivals:', e.message);
  }
}

// 発注明細の行を選んで「入荷管理に追加」する窓口
// order_item_ids（配列）を受け取り、それぞれに対応する入荷管理の行を1件ずつ作成する
// 既に登録済みの明細はスキップする（誤って2回登録してしまうのを防ぐため）
app.post('/api/arrival-schedules', async (req, res) => {
  const { order_item_ids } = req.body;
  if (!Array.isArray(order_item_ids) || order_item_ids.length === 0) {
    return res.status(400).json({ error: '対象の明細が選択されていません' });
  }
  try {
    const { data: existing, error: existingError } = await supabase
      .from('arrival_schedules').select('order_item_id').in('order_item_id', order_item_ids);
    if (existingError) throw new Error(existingError.message);
    const alreadyRegistered = new Set((existing || []).map(r => r.order_item_id));
    const targetIds = order_item_ids.filter(id => !alreadyRegistered.has(id));
    const skipped = order_item_ids.length - targetIds.length;

    if (targetIds.length === 0) {
      return res.json({ success: true, count: 0, skipped: skipped });
    }

    const { data: items, error: itemsError } = await supabase
      .from('order_items').select('*').in('id', targetIds);
    if (itemsError) throw new Error(itemsError.message);

    const rows = [];
    for (const item of items) {
      const carrier = await resolveCarrier(item.maker, item.contract_no);
      rows.push({
        order_item_id: item.id,
        contract_no: item.contract_no,
        shipping_company: carrier,
      });
    }
    const { data, error } = await supabase.from('arrival_schedules').insert(rows).select();
    if (error) throw new Error(error.message);
    res.json({ success: true, count: data.length, skipped: skipped });
  } catch (e) {
    console.error('POST /api/arrival-schedules:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 分納対応：既存の入荷予定行をもとに、同じ契約のもう1行を追加する
// （引取り時期・運送会社は引き継ぎ、入荷予定日・本数・指示書などは空の状態で新しく作る）
app.post('/api/arrival-schedules/:id/split', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  try {
    const { data: original, error: getError } = await supabase
      .from('arrival_schedules').select('*').eq('id', id).maybeSingle();
    if (getError) throw new Error(getError.message);
    if (!original) return res.status(404).json({ error: '元の行が見つかりません' });

    const newRow = {
      order_item_id: original.order_item_id,
      contract_no: original.contract_no,
      pickup_period: original.pickup_period,
      shipping_company: original.shipping_company,
    };
    const { data, error } = await supabase.from('arrival_schedules').insert([newRow]).select();
    if (error) throw new Error(error.message);
    res.json(data && data[0] ? data[0] : { success: true });
  } catch (e) {
    console.error('POST /api/arrival-schedules/:id/split:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/arrival-schedules/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  const { data, error } = await supabase.from('arrival_schedules').update(req.body).eq('id', id).select();
  if (error) { console.error('PUT /api/arrival-schedules/' + id + ':', error.message); return res.status(500).json({ error: error.message }); }
  const updatedRow = data && data[0] ? data[0] : null;
  if (updatedRow) await syncScheduleToArrivals(updatedRow);
  res.json(updatedRow || { success: true });
});

app.delete('/api/arrival-schedules/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  const { error } = await supabase.from('arrival_schedules').delete().eq('id', id);
  if (error) { console.error('DELETE /api/arrival-schedules/' + id + ':', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ success: true });
});

// 入荷管理データを全件削除する窓口（テストデータの整理用）
app.delete('/api/arrival-schedules-all', async (req, res) => {
  const { error } = await supabase.from('arrival_schedules').delete().neq('id', 0);
  if (error) { console.error('DELETE /api/arrival-schedules-all:', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ success: true });
});

// ===== 引取り計画の自動割り振り =====

// 固定の連休カレンダー（月日のみで判定。年は問わない）
// [開始月, 開始日, 終了月, 終了日]
const FIXED_HOLIDAY_RANGES = [
  [4, 29, 5, 5],   // ゴールデンウィーク
  [8, 13, 8, 16],  // お盆
  [12, 29, 12, 31], // 年末
  [1, 1, 1, 3],     // 年始
];

function isHolidayDate(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return FIXED_HOLIDAY_RANGES.some(([sm, sd, em, ed]) => {
    if (sm === em) return m === sm && d >= sd && d <= ed;
    // 月をまたぐ範囲（年末年始は使わないが念のため対応）
    if (sm < em) return (m === sm && d >= sd) || (m === em && d <= ed) || (m > sm && m < em);
    return false;
  });
}

function toDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(date, days) {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function formatMD(date) {
  return (date.getMonth() + 1) + '/' + date.getDate();
}

// 今日から指定の締切日までの「稼働週（月～金で稼働日が2日以上ある週）」一覧を作る
function buildWorkingWeeks(today, deadline) {
  const start = toDateOnly(today);
  const end = toDateOnly(deadline);
  // 今週の月曜日を求める
  const dow = start.getDay(); // 0=日,1=月,...6=土
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  let monday = addDays(start, mondayOffset);
  const weeks = [];
  while (monday <= end) {
    const friday = addDays(monday, 4);
    let workDays = 0;
    for (let i = 0; i < 5; i++) {
      const day = addDays(monday, i);
      if (day < start) continue; // 今日より前の日は数えない
      if (day > end) continue;
      if (!isHolidayDate(day)) workDays++;
    }
    if (workDays >= 2) {
      weeks.push({ start: monday, end: friday, label: formatMD(monday) + '～' + formatMD(friday) });
    }
    monday = addDays(monday, 7);
  }
  return weeks;
}

// 入荷予定日が未入力（まだ出荷案内が来ていない）行に、引取り時期を自動で割り振る
app.post('/api/arrival-schedules/calculate-plan', async (req, res) => {
  const { deadline } = req.body;
  if (!deadline) return res.status(400).json({ error: '締切日が指定されていません' });
  try {
    const { data: all, error } = await supabase
      .from('arrival_schedules').select('*, order_items(*)').order('id', { ascending: true });
    if (error) throw new Error(error.message);

    // order_item_id ごとにグループ化し、「まだ案内が来ていない分」の重量を計算する
    const groups = {};
    for (const row of all) {
      const oid = row.order_item_id;
      if (!groups[oid]) groups[oid] = { orderItem: row.order_items, rows: [] };
      groups[oid].rows.push(row);
    }

    const assignments = []; // { scheduleId, weight }
    for (const oid in groups) {
      const g = groups[oid];
      const oi = g.orderItem;
      if (!oi || !oi.quantity) continue;
      const notifiedQty = g.rows
        .filter(r => r.arrival_date)
        .reduce((sum, r) => sum + (Number(r.arrival_qty) || 0), 0);
      const pendingRows = g.rows.filter(r => !r.arrival_date).sort((a, b) => a.id - b.id);
      if (pendingRows.length === 0) continue;
      const remainingQty = Math.max(0, Number(oi.quantity) - notifiedQty);
      if (remainingQty <= 0) continue;
      const remainingWeight = (Number(oi.weight_kg) || 0) * (remainingQty / Number(oi.quantity));
      assignments.push({ scheduleId: pendingRows[0].id, weight: remainingWeight });
    }

    if (assignments.length === 0) {
      return res.json({ success: true, updatedCount: 0, message: '対象となる行がありませんでした（すべて入荷予定日が入力済みです）' });
    }

    assignments.sort((a, b) => a.scheduleId - b.scheduleId);

    const today = new Date();
    const deadlineDate = new Date(deadline + 'T00:00:00');
    const weeks = buildWorkingWeeks(today, deadlineDate);
    if (weeks.length === 0) {
      return res.status(400).json({ error: '指定された期間内に、稼働できる週がありませんでした' });
    }

    const totalWeight = assignments.reduce((sum, a) => sum + a.weight, 0);
    const weeklyTarget = totalWeight / weeks.length;

    // 週ごとに目標重量に達するまで順番に詰めていく
    let weekIndex = 0;
    let currentWeekTotal = 0;
    for (const a of assignments) {
      if (currentWeekTotal > 0 && (currentWeekTotal + a.weight) > weeklyTarget && weekIndex < weeks.length - 1) {
        weekIndex++;
        currentWeekTotal = 0;
      }
      a.weekLabel = weeks[weekIndex].label;
      currentWeekTotal += a.weight;
    }

    // 1件ずつ更新する
    let updatedCount = 0;
    for (const a of assignments) {
      const { error: updateError } = await supabase
        .from('arrival_schedules').update({ pickup_period: a.weekLabel }).eq('id', a.scheduleId);
      if (!updateError) updatedCount++;
    }

    res.json({
      success: true,
      updatedCount: updatedCount,
      totalWeight: Math.round(totalWeight),
      weeksCount: weeks.length,
      weeklyTarget: Math.round(weeklyTarget),
    });
  } catch (e) {
    console.error('POST /api/arrival-schedules/calculate-plan:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('サーバー起動中 ポート:' + PORT);
});
