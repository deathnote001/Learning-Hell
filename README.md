一个面向中学生的累计型学习工具，涵盖古诗词默写、英语单词练习和历史选择题。支持家长/学生双角色登录，带错题本和学习数据统计。
给亲戚家小孩做着玩的^^

## 功能

- **古诗词**：知识预热 → 上下句填写 → 整首默写解锁
- **英语单词**：看意填词 / 听音写词 / 听音选意，三种题型混合练习
- **历史真题**：选择题，按朝代分类，点击展开知识点预览
- **错题本**：自动收集错题，次日复习，支持导出
- **家长端**：学习报告、打卡日历、各模块正确率统计、内容管理（上传题库）

## 技术栈

- React + Vite
- Supabase (PostgreSQL + REST API)
- Vercel 部署

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/deathnote001/learning-for-yourself-web.git
cd learning-for-yourself-web
npm install
```

### 2. 配置 Supabase

1. 注册 [Supabase](https://supabase.com)，创建新项目
2. 在 SQL Editor 中运行 `supabase_schema.sql` 创建数据表
3. 复制 `.env.example` 为 `.env.local`，填入你的 Supabase URL 和 anon key

```
VITE_SUPABASE_URL=https://你的项目ID.supabase.co
VITE_SUPABASE_ANON_KEY=你的anon_key
```

### 3. 设置用户密码

在浏览器控制台生成密码 hash：

```js
async function h(pw){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(pw));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");}
h("你的密码").then(console.log)
```

在 Supabase SQL Editor 中插入用户：

```sql
INSERT INTO users (username, password_hash, role) VALUES ('student_name', '生成的hash', 'student');
INSERT INTO users (username, password_hash, role) VALUES ('parent_name', '生成的hash', 'parent');
```

### 4. 本地运行

```bash
npm run dev
```

### 5. 部署到 Vercel

1. 将项目推送到 GitHub
2. 在 [Vercel](https://vercel.com) 导入仓库
3. 在 Environment Variables 中添加 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`
4. 部署完成

## 自定义题库

通过家长端「内容管理」页面上传 JSON 文件即可替换题库，支持古诗词、单词、历史三个模块。

## License

MIT
