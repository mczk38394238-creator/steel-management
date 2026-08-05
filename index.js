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
// 2026/8/5：入荷管理（arrival_schedules・arrivals）は order_items を親として参照しているため、
// 先に消さないと「子がいるので親を削除できない」エラーになる。なので順番が重要。
const RELATED_TABLES = [
  // 'mill_sheets',       // ミルシート（追加予定）
  // 'invoices',          // 請求（追加予定）
  // 'connections',       // 取合（追加予定）
  // 'inventory',         // 在庫（追加予定）
];

async function deleteProjectCascade(projectId) {
  // order_items のidを先に取得しておく（arrival_schedules・cutting_plans等はこのidを参照しているため）
  const { data: items, error: itemsError } = await supabase
    .from('order_items').select('id').eq('project_id', projectId);
  if (itemsError) throw new Error('order_items の取得失敗: ' + itemsError.message);
  const itemIds = (items || []).map(function (i) { return i.id; });

  if (itemIds.length > 0) {
    // 2026/8/5：arrivals テーブルは order_item_id だけでなく、
    // arrival_schedules を schedule_id で参照している（親子関係）。
    // なので、必ず arrivals → arrival_schedules の順で先に消す必要がある。
    const { data: schedules, error: schedGetError } = await supabase
      .from('arrival_schedules').select('id').in('order_item_id', itemIds);
    if (schedGetError) throw new Error('arrival_schedules の取得失敗: ' + schedGetError.message);
    const scheduleIds = (schedules || []).map(function (s) { return s.id; });

    if (scheduleIds.length > 0) {
      const { error: arrError } = await supabase.from('arrivals').delete().in('schedule_id', scheduleIds);
      if (arrError) throw new Error('arrivals の削除失敗: ' + arrError.message);
    }
    // 念のため、schedule_idでは紐づいていないが order_item_id だけで残っているarrivalsも消しておく
    const { error: arrError2 } = await supabase.from('arrivals').delete().in('order_item_id', itemIds);
    if (arrError2) throw new Error('arrivals の削除失敗: ' + arrError2.message);

    const { error: schedError } = await supabase.from('arrival_schedules').delete().in('order_item_id', itemIds);
    if (schedError) throw new Error('arrival_schedules の削除失敗: ' + schedError.message);

    // 2026/8/5：まだ本格的に使っていない機能（今後追加予定のもの）だが、
    // order_item_id で order_items を参照しているため、将来のために先に消しておく
    const { error: cuttingError } = await supabase.from('cutting_plans').delete().in('order_item_id', itemIds);
    if (cuttingError) throw new Error('cutting_plans の削除失敗: ' + cuttingError.message);
    const { error: invoiceError } = await supabase.from('invoices').delete().in('order_item_id', itemIds);
    if (invoiceError) throw new Error('invoices の削除失敗: ' + invoiceError.message);
    const { error: millError } = await supabase.from('mill_sheets').delete().in('order_item_id', itemIds);
    if (millError) throw new Error('mill_sheets の削除失敗: ' + millError.message);
  }

  for (const table of RELATED_TABLES) {
    const { error } = await supabase.from(table).delete().eq('project_id', projectId);
    if (error) throw new Error(table + ' の削除失敗: ' + error.message);
  }

  const { error: orderError } = await supabase.from('order_items').delete().eq('project_id', projectId);
  if (orderError) throw new Error('order_items の削除失敗: ' + orderError.message);
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
    .from('order_items')
    .select('*, arrival_schedules(id, actual_arrival_qty)')
    .eq('project_id', req.params.projectId)
    .order('seq_no', { ascending: true });
  if (error) { console.error('GET /api/order-items:', error.message); return res.status(500).json({ error: error.message }); }
  // 2026/8/5：入荷本数・未入荷本数・未入荷重量は、都度、実績（actual_arrival_qty）の合計から計算し直す。
  // （こうしておけば、過去に登録済みで一度も実績を編集していない行も、常に正しい数字になる）
  const result = (data || []).map(function (item) {
    var arrivedQty = (item.arrival_schedules || []).reduce(function (sum, s) {
      return sum + (Number(s.actual_arrival_qty) || 0);
    }, 0);
    var pendingQty = null, pendingWeight = null;
    if (item.quantity !== null && item.quantity !== undefined && Number(item.quantity) > 0) {
      pendingQty = Math.max(0, Number(item.quantity) - arrivedQty);
      pendingWeight = Math.round((Number(item.weight_kg) || 0) * (pendingQty / Number(item.quantity)));
    }
    return Object.assign({}, item, {
      arrived_qty: arrivedQty,
      pending_qty: pendingQty,
      pending_weight_kg: pendingWeight,
    });
  });
  res.json(result);
});

// 固定：手配が完了した明細を「固定済み」にする（対象物件でまだ固定していない行をまとめて固定）
app.post('/api/order-items/fix', async (req, res) => {
  const { project_id } = req.body;
  if (!project_id) return res.status(400).json({ error: '物件が選択されていません' });
  const { data, error } = await supabase
    .from('order_items')
    .update({ is_fixed: true, fixed_at: new Date().toISOString() })
    .eq('project_id', project_id)
    .eq('is_fixed', false)
    .select();
  if (error) { console.error('POST /api/order-items/fix:', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ success: true, count: (data || []).length });
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
  try {
    // 処理開始：「処理中」フラグを立てる（他の担当者の画面にも表示される）
    await supabase.from('projects').update({
      import_status: 'processing',
      import_started_at: new Date().toISOString()
    }).eq('id', project_id);

    if (mode === 'replace') {
      const { error: deleteError } = await supabase.from('order_items').delete().eq('project_id', project_id);
      if (deleteError) throw new Error(deleteError.message);
    }
    // 2026/8/5：入荷本数・未入荷本数・未入荷重量は、実績（入荷管理画面の実入荷本数）から
    // 自動計算する仕組みに変更したため、新規登録の時点では「まだ実績0件」の初期値で上書きする。
    // （員数が未確定の市中材は、そのままnullにしておく）
    const rows = items.map(item => {
      var quantity = item.quantity;
      var pendingQty = null, pendingWeight = null;
      if (quantity !== null && quantity !== undefined && Number(quantity) > 0) {
        pendingQty = Number(quantity);
        pendingWeight = Number(item.weight_kg) || 0;
      }
      return Object.assign({}, item, {
        project_id: project_id,
        arrived_qty: 0,
        pending_qty: pendingQty,
        pending_weight_kg: pendingWeight,
      });
    });
    const { data, error } = await supabase.from('order_items').insert(rows).select();
    if (error) throw new Error(error.message);
    res.json({ success: true, count: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    // 処理終了：成功・失敗にかかわらず必ず「処理中」フラグを解除する
    await supabase.from('projects').update({
      import_status: null,
      import_started_at: null
    }).eq('id', project_id);
  }
});

// ===== 入荷管理 =====

// 入荷予定を全件取得する窓口（全物件横断・発注明細と物件情報も一緒に取得）
app.get('/api/arrival-schedules', async (req, res) => {
  const { data, error } = await supabase
    .from('arrival_schedules')
    .select('*, order_items(*, projects(project_name, status))')
    .order('id', { ascending: true });
  if (error) { console.error('GET /api/arrival-schedules:', error.message); return res.status(500).json({ error: error.message }); }
  // 2026/8/5：物件マスターでゴミ箱に移した（status !== 'active'）物件の行は、
  // 資材部管理画面と同じように、入荷管理画面にも出さないようにする
  const filtered = (data || []).filter(function (row) {
    var proj = row.order_items && row.order_items.projects;
    return !proj || proj.status === 'active';
  });
  res.json(filtered);
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
// 2026/8/5：「予定（arrival_date/arrival_qty）」と「実績（actual_arrival_date/actual_arrival_qty）」を
// 明確に分けるため、ここで参照する列を実績側に変更した。
// 実績の日・本数の両方が入っている行だけを対象に、対応する実績行を作成・更新する
// すでに実績行がある場合（schedule_idで判定）は新規作成せず上書き更新する
async function syncScheduleToArrivals(scheduleRow) {
  if (!scheduleRow || !scheduleRow.actual_arrival_date ||
      scheduleRow.actual_arrival_qty === null || scheduleRow.actual_arrival_qty === undefined) {
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
      arrival_date: scheduleRow.actual_arrival_date,
      arrived_qty: scheduleRow.actual_arrival_qty,
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

// 2026/8/5：資材部管理画面の「入荷本数・未入荷本数・未入荷重量」を、実績（actual_arrival_qty）から
// 自動計算して書き戻すヘルパー。実績が1件も無い場合は「入荷本数0・未入荷本数＝員数の全部」になる。
// 契約Noや員数が未確定の市中材（quantityがnull）の場合は、計算せずnullのままにする。
async function recalcOrderItemArrival(orderItemId) {
  if (!orderItemId) return;
  try {
    const { data: schedules, error: schedError } = await supabase
      .from('arrival_schedules').select('actual_arrival_qty').eq('order_item_id', orderItemId);
    if (schedError) throw new Error(schedError.message);
    const arrivedQty = (schedules || []).reduce(function (sum, r) {
      return sum + (Number(r.actual_arrival_qty) || 0);
    }, 0);

    const { data: oi, error: oiError } = await supabase
      .from('order_items').select('quantity, weight_kg').eq('id', orderItemId).maybeSingle();
    if (oiError) throw new Error(oiError.message);
    if (!oi) return;

    var pendingQty = null;
    var pendingWeight = null;
    if (oi.quantity !== null && oi.quantity !== undefined && Number(oi.quantity) > 0) {
      pendingQty = Math.max(0, Number(oi.quantity) - arrivedQty);
      pendingWeight = Math.round((Number(oi.weight_kg) || 0) * (pendingQty / Number(oi.quantity)));
    }

    await supabase.from('order_items').update({
      arrived_qty: arrivedQty,
      pending_qty: pendingQty,
      pending_weight_kg: pendingWeight,
    }).eq('id', orderItemId);
  } catch (e) {
    console.error('recalcOrderItemArrival:', e.message);
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
      // 資材部管理画面で運送会社が入力済みならそれを優先。未入力の場合のみ従来通りcarriers_masterから自動判定する
      const carrier = item.carrier || await resolveCarrier(item.maker, item.contract_no);
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

// 資材部管理画面から出力したExcelを、入荷管理画面に貼り付けて一括登録する窓口
// rows: [{ order_item_id, arrival_date, arrival_qty }, ...]
// id列（order_item_id）が1件でもorder_itemsに存在しない場合は、登録を全体ブロックしてエラーを返す
app.post('/api/arrival-schedules/paste', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: '登録するデータがありません' });
  }
  try {
    const ids = rows.map(r => r.order_item_id);
    const { data: items, error: itemsError } = await supabase
      .from('order_items').select('*').in('id', ids);
    if (itemsError) throw new Error(itemsError.message);

    const itemMap = {};
    (items || []).forEach(item => { itemMap[item.id] = item; });

    // 1件でも資材部管理画面のデータに存在しないidがあれば、その回の登録を丸ごとブロックする
    const invalidIds = ids.filter(id => !itemMap[id]);
    if (invalidIds.length > 0) {
      return res.status(400).json({
        error: 'IDが一致しない行があります（' + invalidIds.length + '件）。資材部管理画面から出力しなおしてください。 不一致のid: ' + invalidIds.join(', ')
      });
    }

    const newRows = [];
    for (const r of rows) {
      const item = itemMap[r.order_item_id];
      const carrier = item.carrier || await resolveCarrier(item.maker, item.contract_no);
      newRows.push({
        order_item_id: item.id,
        contract_no: item.contract_no,
        shipping_company: carrier,
        arrival_date: r.arrival_date || null,
        arrival_qty: r.arrival_qty !== null && r.arrival_qty !== undefined && r.arrival_qty !== '' ? Number(r.arrival_qty) : null,
      });
    }
    const { data, error } = await supabase.from('arrival_schedules').insert(newRows).select();
    if (error) throw new Error(error.message);
    // 2026/8/5：ここで登録するのは「入荷予定」であり「実績」ではないため、
    // 資材部管理画面の入荷本数などへは反映しない（実績は入荷管理画面の「実入荷日・実入荷本数」欄に
    // 入力された時だけ反映される。下のPUTエンドポイントを参照）。
    res.json({ success: true, count: data.length });
  } catch (e) {
    console.error('POST /api/arrival-schedules/paste:', e.message);
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
  if (updatedRow) {
    await syncScheduleToArrivals(updatedRow);
    // 2026/8/5：実績（actual_arrival_qty）を編集した時は、資材部管理画面の入荷本数などを再計算する
    if (Object.prototype.hasOwnProperty.call(req.body, 'actual_arrival_qty')) {
      await recalcOrderItemArrival(updatedRow.order_item_id);
    }
  }
  res.json(updatedRow || { success: true });
});

app.delete('/api/arrival-schedules/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '無効なIDです' });
  // 2026/8/5：削除する行にも実績が入っていた可能性があるので、削除前にorder_item_idを控えておき、
  // 削除後に資材部管理画面側の自動計算をやり直す
  const { data: target } = await supabase.from('arrival_schedules').select('order_item_id').eq('id', id).maybeSingle();
  const { error } = await supabase.from('arrival_schedules').delete().eq('id', id);
  if (error) { console.error('DELETE /api/arrival-schedules/' + id + ':', error.message); return res.status(500).json({ error: error.message }); }
  if (target) await recalcOrderItemArrival(target.order_item_id);
  res.json({ success: true });
});

// 2026/8/5 非表示化：開発・テスト用だったため無効化。復活させたい時は、このコメント範囲の印を外してください
// app.delete('/api/arrival-schedules-all', async (req, res) => {
//   const { error } = await supabase.from('arrival_schedules').delete().neq('id', 0);
//   if (error) { console.error('DELETE /api/arrival-schedules-all:', error.message); return res.status(500).json({ error: error.message }); }
//   res.json({ success: true });
// });

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
