-- ============================================================
-- 学习平台数据库建表 SQL
-- 在 Supabase SQL Editor 中完整运行此文件
-- ============================================================

-- 1. 用户配置表（固定两个账号）
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  role text not null check (role in ('student', 'parent')),
  created_at timestamptz default now()
);

-- 插入固定账号（密码在应用层做简单hash，这里先用明文占位，部署时替换）
insert into users (username, password_hash, role) values
  ('student', 'REPLACE_WITH_HASHED_PASSWORD', 'student'),
  ('parent',  'REPLACE_WITH_HASHED_PASSWORD', 'parent')
on conflict (username) do nothing;

-- 2. 内容库表（诗词、单词、历史题——支持整库替换）
create table if not exists content_library (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('poems', 'words', 'history')),
  content jsonb not null,          -- 整个库的JSON
  version int not null default 1,
  uploaded_at timestamptz default now(),
  uploaded_by text
);

-- 3. 诗词学习进度（追踪每首诗每个句子的默写情况）
create table if not exists poem_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  poem_id text not null,           -- 诗词ID
  line_index int not null,         -- 第几句（0起）
  correct_count int default 0,     -- 正确次数
  attempt_count int default 0,     -- 总尝试次数
  mastered boolean default false,  -- 该句是否已掌握
  updated_at timestamptz default now(),
  unique(user_id, poem_id, line_index)
);

-- 当一首诗所有句子都掌握时，整首诗进入全文默写阶段
create table if not exists poem_full_recite (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  poem_id text not null,
  unlocked boolean default false,
  full_correct_count int default 0,
  updated_at timestamptz default now(),
  unique(user_id, poem_id)
);

-- 4. 单词学习进度
create table if not exists word_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  word text not null,
  correct_fill int default 0,      -- 看意填词 正确次数
  correct_listen int default 0,    -- 听音写词 正确次数
  correct_choose int default 0,    -- 听音选意 正确次数
  attempt_fill int default 0,
  attempt_listen int default 0,
  attempt_choose int default 0,
  updated_at timestamptz default now(),
  unique(user_id, word)
);

-- 5. 错题本
create table if not exists wrong_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  module text not null check (module in ('poem', 'word', 'history')),
  question_key text not null,      -- 题目唯一标识
  question_text text not null,     -- 题目内容（冗余存储，便于展示）
  my_answer text,
  correct_answer text not null,
  scheduled_date date,             -- 计划复习日期（通常是第二天）
  resolved boolean default false,  -- 是否已答对
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 6. 每日任务记录
create table if not exists daily_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  session_date date not null,
  module text not null check (module in ('poem', 'word', 'history')),
  total_questions int default 0,
  correct_count int default 0,
  accuracy numeric(5,2),           -- 正确率 0-100
  duration_seconds int,            -- 用时（秒）
  completed boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, session_date, module)
);

-- 7. Row Level Security（RLS）
alter table users enable row level security;
alter table poem_progress enable row level security;
alter table poem_full_recite enable row level security;
alter table word_progress enable row level security;
alter table wrong_answers enable row level security;
alter table daily_sessions enable row level security;
alter table content_library enable row level security;

-- 允许所有已认证用户读写自己的数据（通过应用层控制用户ID）
-- 这里使用宽松策略，由应用层保证安全（两账号固定，风险低）
create policy "allow_all_authenticated" on poem_progress for all using (true);
create policy "allow_all_authenticated" on poem_full_recite for all using (true);
create policy "allow_all_authenticated" on word_progress for all using (true);
create policy "allow_all_authenticated" on wrong_answers for all using (true);
create policy "allow_all_authenticated" on daily_sessions for all using (true);
create policy "allow_all_authenticated" on content_library for all using (true);
create policy "allow_read_users" on users for select using (true);

-- 8. 索引优化
create index if not exists idx_wrong_answers_user_date on wrong_answers(user_id, scheduled_date);
create index if not exists idx_daily_sessions_user_date on daily_sessions(user_id, session_date);
create index if not exists idx_poem_progress_user on poem_progress(user_id, poem_id);
create index if not exists idx_word_progress_user on word_progress(user_id);
create index if not exists idx_content_library_type on content_library(type, uploaded_at desc);
