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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('サーバー起動中 ポート:' + PORT);
});
