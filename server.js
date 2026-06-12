const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
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

// 物件登録
app.post('/api/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .insert([req.body])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動：ポート${PORT}`);
});
