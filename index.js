const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// WebSocket問題を回避するためglobalに設定
const WebSocket = require('ws');
global.WebSocket = WebSocket;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get('/api/projects', async (req, res) => {
  const { data, error } = await supabase.from('projects').select('*').order('id', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/projects', async (req, res) => {
  const { data, error } = await supabase.from('projects').insert([req.body]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/projects/:id', async (req, res) => {
  const { data, error } = await supabase.from('projects').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/api/projects/:id', async (req, res) => {
  const { error } = await supabase.from('projects').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/order-items/:projectId', async (req, res) => {
  const { data, error } = await supabase.from('order_items').select('*').eq('project_id', req.params.projectId).order('tsushi_no', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

app.delete('/api/order-items/project/:projectId', async (req, res) => {
  const { error } = await supabase.from('order_items').delete().eq('project_id', req.params.projectId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('サーバー起動中 ポート:' + PORT);
});
