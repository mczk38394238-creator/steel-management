const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 物件一覧取得
app.get('/api/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 物件新規登録
app.post('/api/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .insert([req.body])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// 物件更新（ステータス変更・編集）
app.put('/api/projects/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .update(req.body)
    .eq('id', req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// 物件削除
app.delete('/api/projects/:id', async (req, res) => {
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動中：ポート${PORT}`);
});

// 発注明細一覧取得（物件別）
app.get('/api/order-details/:projectId', async (req, res) => {
  const { data, error } = await supabase
    .from('order_items')
    .select('*')
    .eq('project_id', req.params.projectId)
    .order('seq_no', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 発注明細登録
app.post('/api/order-details', async (req, res) => {
  const { data, error } = await supabase
    .from('order_items')
    .insert(req.body)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// 発注明細更新
app.put('/api/order-details/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('order_items')
    .update(req.body)
    .eq('id', req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// 発注明細削除
app.delete('/api/order-details/:id', async (req, res) => {
  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});
