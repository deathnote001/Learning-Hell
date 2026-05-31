import { useState, useEffect, useRef, useCallback } from "react";
import poemsData from "./data/poems.json";
import wordsData from "./data/words.json";
import historyData from "./data/history.json";

// ── Supabase client ───────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    ...options,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const db = {
  get: (table, query = "") => sb(`${table}?${query}`),
  post: (table, body) => sb(table, { method: "POST", body: JSON.stringify(body) }),
  patch: (table, query, body) =>
    sb(`${table}?${query}`, { method: "PATCH", body: JSON.stringify(body), prefer: "return=representation" }),
  upsert: (table, body) =>
    sb(table, { method: "POST", body: JSON.stringify(body), prefer: "resolution=merge-duplicates,return=representation" }),
  delete: (table, query) => sb(`${table}?${query}`, { method: "DELETE" }),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => s.replace(/[，。？！；：、""''《》\s]/g, "");
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

function speakWord(word) {
  const u = new SpeechSynthesisUtterance(word);
  u.lang = "en-US";
  u.rate = 0.82;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Simple password hash (SHA-256 via Web Crypto)
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Login Screen ──────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const hash = await hashPassword(password);
      const rows = await db.get("users", `username=eq.${username}&password_hash=eq.${hash}&select=id,username,role`);
      if (rows && rows.length > 0) {
        onLogin(rows[0]);
      } else {
        setError("用户名或密码错误");
      }
    } catch {
      setError("连接失败，请检查网络");
    }
    setLoading(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-icon">📚</div>
        <h1 className="login-title">每日学习</h1>
        <p className="login-sub">古诗词 · 单词 · 历史</p>
        <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            className="login-input"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoComplete="username"
          />
          <input
            className="login-input"
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <div className="login-error">{error}</div>}
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Poem Module ───────────────────────────────────────────────────────────────
function PoemModule({ userId, poems }) {
  const [phase, setPhase] = useState("warmup"); // warmup | test | review
  const [questions, setQuestions] = useState([]);
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [done, setDone] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  // Build today's questions: line-by-line fill, plus whole-poem if mastered
  useEffect(() => {
    if (phase !== "test") return;
    buildQuestions();
  }, [phase]);

  async function buildQuestions() {
    // Fetch progress from DB
    let progress = [];
    try {
      progress = await db.get("poem_progress", `user_id=eq.${userId}`);
    } catch {}

    // Fetch wrong answers scheduled today
    let wrongToday = [];
    try {
      wrongToday = await db.get(
        "wrong_answers",
        `user_id=eq.${userId}&module=eq.poem&scheduled_date=eq.${today()}&resolved=eq.false`
      );
    } catch {}

    const progressMap = {};
    (progress || []).forEach((p) => {
      progressMap[`${p.poem_id}-${p.line_index}`] = p;
    });

    const qs = [];

    // First: wrong answers from yesterday
    (wrongToday || []).forEach((w) => {
      qs.push({ type: "line", fromWrong: true, wrongId: w.id, ...JSON.parse(w.question_text) });
    });

    // Then: regular questions
    poems.forEach((poem) => {
      poem.lines.forEach((line, i) => {
        if (i === poem.lines.length - 1) return; // last line has no "next"
        const key = `${poem.id}-${i}`;
        const prog = progressMap[key];
        const mastered = prog?.mastered || false;
        if (!mastered) {
          const dir = Math.random() > 0.5 ? "next" : "prev";
          const promptIdx = dir === "next" ? i : i + 1;
          const answerIdx = dir === "next" ? i + 1 : i;
          if (answerIdx < poem.lines.length) {
            qs.push({
              type: "line",
              poemId: poem.id,
              poemTitle: poem.title,
              poemAuthor: poem.author,
              lineIndex: i,
              prompt: poem.lines[promptIdx],
              answer: poem.lines[answerIdx],
              dir,
            });
          }
        }
      });
    });

    // Check full-poem recite unlock
    const fullRecite = await db.get("poem_full_recite", `user_id=eq.${userId}&unlocked=eq.true`).catch(() => []);
    (fullRecite || []).forEach((fr) => {
      const poem = poems.find((p) => p.id === fr.poem_id);
      if (poem) {
        qs.push({ type: "full", poemId: poem.id, poemTitle: poem.title, poemAuthor: poem.author, lines: poem.lines });
      }
    });

    setQuestions(shuffle(qs).slice(0, 5));
    setIdx(0);
    setDone(0);
    setInput("");
    setFeedback(null);
    setSubmitted(false);
  }

  async function submit() {
    if (submitted) return;
    const q = questions[idx];
    if (!input.trim()) { setFeedback({ ok: null, msg: "请先填写答案" }); return; }

    let isCorrect = false;
    if (q.type === "line") {
      isCorrect = norm(input) === norm(q.answer);
    } else {
      // full poem: compare all lines joined
      isCorrect = norm(input) === norm(q.lines.join(""));
    }

    setSubmitted(true);
    setFeedback({ ok: isCorrect, msg: isCorrect ? "✓ 正确！" : `✗ 正确答案：${q.answer || q.lines.join(" / ")}` });

    // Update DB
    try {
      if (q.type === "line" && q.poemId) {
        const prog = await db.get("poem_progress", `user_id=eq.${userId}&poem_id=eq.${q.poemId}&line_index=eq.${q.lineIndex}`);
        const existing = prog?.[0];
        const newCorrect = (existing?.correct_count || 0) + (isCorrect ? 1 : 0);
        const newAttempt = (existing?.attempt_count || 0) + 1;
        const mastered = newCorrect >= 3;
        await db.upsert("poem_progress", {
          user_id: userId, poem_id: q.poemId, line_index: q.lineIndex,
          correct_count: newCorrect, attempt_count: newAttempt, mastered, updated_at: new Date().toISOString(),
        });

        // Check if whole poem mastered
        if (mastered) {
          const poem = poems.find((p) => p.id === q.poemId);
          if (poem) {
            const allProg = await db.get("poem_progress", `user_id=eq.${userId}&poem_id=eq.${q.poemId}&mastered=eq.true`);
            if ((allProg || []).length >= poem.lines.length - 1) {
              await db.upsert("poem_full_recite", { user_id: userId, poem_id: q.poemId, unlocked: true, updated_at: new Date().toISOString() });
            }
          }
        }
      }
      if (!isCorrect) {
        await db.post("wrong_answers", {
          user_id: userId, module: "poem",
          question_key: `${q.poemId}-${q.lineIndex}`,
          question_text: JSON.stringify({ poemId: q.poemId, poemTitle: q.poemTitle, poemAuthor: q.poemAuthor, lineIndex: q.lineIndex, prompt: q.prompt, answer: q.answer, dir: q.dir }),
          my_answer: input,
          correct_answer: q.answer || "",
          scheduled_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        });
      } else if (q.fromWrong) {
        await db.patch("wrong_answers", `id=eq.${q.wrongId}`, { resolved: true });
      }
    } catch {}

    setTimeout(() => {
      if (idx + 1 >= questions.length) {
        setPhase("review");
      } else {
        setIdx((i) => i + 1);
        setInput("");
        setFeedback(null);
        setSubmitted(false);
        setDone((d) => d + 1);
      }
    }, 1500);
  }

  function skip() {
    const q = questions[idx];
    setFeedback({ ok: null, msg: `已跳过，答案：${q.answer || q.lines?.join(" ")}` });
    setSubmitted(true);
    setTimeout(() => {
      if (idx + 1 >= questions.length) setPhase("review");
      else { setIdx((i) => i + 1); setInput(""); setFeedback(null); setSubmitted(false); }
    }, 1500);
  }

  if (phase === "warmup") return (
    <div>
      <div className="card">
        <div className="warmup-title">📖 今日预热 · 古诗词</div>
        {poems.map((p) => (
          <div className="warmup-block" key={p.id}>
            <div className="warmup-poem-title">《{p.title}》{p.author}（{p.dynasty}）</div>
            <div className="warmup-poem-lines">{p.lines.join("　")}</div>
          </div>
        ))}
        <div className="start-btn-wrap">
          <button className="btn btn-primary" onClick={() => setPhase("test")}>我已熟悉，开始答题 →</button>
        </div>
      </div>
    </div>
  );

  if (phase === "review") return (
    <div>
      <div className="done-banner">🎉 今日古诗词任务完成！</div>
      <div className="card">
        <div className="warmup-title">📖 回顾今日内容</div>
        {poems.map((p) => (
          <div className="warmup-block" key={p.id}>
            <div className="warmup-poem-title">《{p.title}》{p.author}（{p.dynasty}）</div>
            <div className="warmup-poem-lines">{p.lines.join("　")}</div>
          </div>
        ))}
        <div className="start-btn-wrap">
          <button className="btn" onClick={() => { setPhase("warmup"); setIdx(0); setDone(0); }}>重新开始</button>
        </div>
      </div>
    </div>
  );

  const q = questions[idx];
  if (!q) return <div className="loading">加载中...</div>;

  return (
    <div>
      <div className="card">
        <div className="section-label">古诗词填写 · 第 {idx + 1} 题 / {questions.length} 题</div>
        {q.fromWrong && <div className="wrong-tag">错题复习</div>}
        <div className="poem-meta">《{q.poemTitle}》· {q.poemAuthor}</div>
        {q.type === "line" ? (
          <>
            <div className="poem-prompt-line">已知：{q.prompt}</div>
            <div className="poem-ask">请写出{q.dir === "next" ? "下一句" : "上一句"}：</div>
            <input className="poem-input" value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !submitted && submit()}
              placeholder="在此默写..." disabled={submitted} />
          </>
        ) : (
          <>
            <div className="poem-ask">整首默写：</div>
            <textarea className="poem-textarea" value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={`请默写《${q.poemTitle}》全文...`} rows={q.lines.length + 1} disabled={submitted} />
          </>
        )}
        {feedback && (
          <div className={`feedback ${feedback.ok === true ? "ok" : feedback.ok === false ? "err" : "neutral"}`}>
            {feedback.msg}
          </div>
        )}
        <div className="btn-row">
          <button className="btn" onClick={skip} disabled={submitted}>跳过</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitted}>提交</button>
        </div>
      </div>
      <ProgressCard done={idx} total={questions.length} />
    </div>
  );
}

// ── Word Module ───────────────────────────────────────────────────────────────
const WORD_TYPES = ["fill", "listen", "choose", "fill", "listen", "choose", "fill", "listen", "choose", "fill"];

function WordModule({ userId, words }) {
  const [phase, setPhase] = useState("warmup");
  const [questions, setQuestions] = useState([]);
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (phase === "test") buildQuestions();
  }, [phase]);

  function buildQuestions() {
    const picked = shuffle(words).slice(0, 10);
    const qs = picked.map((w, i) => ({ word: w, type: WORD_TYPES[i] }));
    setQuestions(qs);
    setIdx(0); setInput(""); setSelected(null); setFeedback(null); setSubmitted(false);
  }

  async function submit() {
    if (submitted) return;
    const q = questions[idx];
    let isCorrect = false;
    let myAnswer = "";

    if (q.type === "choose") {
      if (!selected) { setFeedback({ ok: null, msg: "请先选择" }); return; }
      isCorrect = selected.correct;
      myAnswer = selected.meaning;
    } else {
      if (!input.trim()) { setFeedback({ ok: null, msg: "请先输入" }); return; }
      isCorrect = input.trim().toLowerCase() === q.word.word.toLowerCase();
      myAnswer = input.trim();
    }

    setSubmitted(true);
    setFeedback({ ok: isCorrect, msg: isCorrect ? "✓ 正确！" : `✗ 正确：${q.word.word}（${q.word.meaning}）` });

    try {
      const col = q.type === "fill" ? "fill" : q.type === "listen" ? "listen" : "choose";
      const existing = await db.get("word_progress", `user_id=eq.${userId}&word=eq.${q.word.word}`);
      const e = existing?.[0] || {};
      await db.upsert("word_progress", {
        user_id: userId, word: q.word.word,
        [`correct_${col}`]: (e[`correct_${col}`] || 0) + (isCorrect ? 1 : 0),
        [`attempt_${col}`]: (e[`attempt_${col}`] || 0) + 1,
        updated_at: new Date().toISOString(),
      });
      if (!isCorrect) {
        await db.post("wrong_answers", {
          user_id: userId, module: "word",
          question_key: `${q.word.word}-${q.type}`,
          question_text: JSON.stringify({ word: q.word.word, meaning: q.word.meaning, type: q.type }),
          my_answer: myAnswer,
          correct_answer: q.word.word,
          scheduled_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        });
      }
    } catch {}

    setTimeout(() => {
      if (idx + 1 >= questions.length) setPhase("review");
      else { setIdx((i) => i + 1); setInput(""); setSelected(null); setFeedback(null); setSubmitted(false); }
    }, 1400);
  }

  function skip() {
    const q = questions[idx];
    setFeedback({ ok: null, msg: `已跳过，单词：${q.word.word}（${q.word.meaning}）` });
    setSubmitted(true);
    setTimeout(() => {
      if (idx + 1 >= questions.length) setPhase("review");
      else { setIdx((i) => i + 1); setInput(""); setSelected(null); setFeedback(null); setSubmitted(false); }
    }, 1400);
  }

  if (phase === "warmup") return (
    <div>
      <div className="card">
        <div className="warmup-title">🔤 今日预热 · 单词</div>
        <div className="word-card-list">
          {shuffle(words).slice(0, 10).map((w) => (
            <div className="word-warmup-card" key={w.word}>
              <div>
                <div className="word-en">{w.word}</div>
                <div className="word-cn-small">{w.meaning}</div>
              </div>
              <button className="speak-btn" onClick={() => speakWord(w.word)}>
                🔊 听音
              </button>
            </div>
          ))}
        </div>
        <div className="start-btn-wrap">
          <button className="btn btn-primary" onClick={() => setPhase("test")}>我已熟悉，开始答题 →</button>
        </div>
      </div>
    </div>
  );

  if (phase === "review") return (
    <div>
      <div className="done-banner">🎉 今日单词任务完成！</div>
      <div className="card">
        <div className="warmup-title">🔤 回顾今日单词</div>
        <div className="word-card-list">
          {questions.map((q) => (
            <div className="word-warmup-card" key={q.word.word}>
              <div>
                <div className="word-en">{q.word.word}</div>
                <div className="word-cn-small">{q.word.meaning}</div>
              </div>
              <button className="speak-btn" onClick={() => speakWord(q.word.word)}>🔊 听音</button>
            </div>
          ))}
        </div>
        <div className="start-btn-wrap">
          <button className="btn" onClick={() => setPhase("warmup")}>重新开始</button>
        </div>
      </div>
    </div>
  );

  const q = questions[idx];
  if (!q) return <div className="loading">加载中...</div>;

  const typeLabel = { fill: "看意填词", listen: "听音写词", choose: "听音选意" }[q.type];
  const typeColor = { fill: "info", listen: "warning", choose: "success" }[q.type];

  // Build choices for "choose" type
  const choices = q.type === "choose"
    ? shuffle([
        { meaning: q.word.meaning, correct: true },
        ...shuffle(words.filter((w) => w.word !== q.word.word)).slice(0, 3).map((w) => ({ meaning: w.meaning, correct: false })),
      ])
    : [];

  return (
    <div>
      <div className="card">
        <div className="section-label">单词练习 · 第 {idx + 1} 题 / {questions.length} 题</div>
        <span className={`type-badge badge-${typeColor}`}>{typeLabel}</span>

        {q.type === "fill" && (
          <>
            <div className="word-prompt">中文意思：<strong>{q.word.meaning}</strong></div>
            <input className="word-input" value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !submitted && submit()}
              placeholder="输入英文单词..." autoCapitalize="none" disabled={submitted} />
          </>
        )}

        {q.type === "listen" && (
          <>
            <div className="speak-row">
              <button className="speak-btn-big" onClick={() => speakWord(q.word.word)}>🔊 播放发音</button>
            </div>
            <input className="word-input" value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !submitted && submit()}
              placeholder="输入你听到的单词..." autoCapitalize="none" disabled={submitted} />
          </>
        )}

        {q.type === "choose" && (
          <>
            <div className="speak-row">
              <button className="speak-btn-big" onClick={() => speakWord(q.word.word)}>🔊 播放发音</button>
            </div>
            <div className="choice-list">
              {choices.map((c, i) => (
                <div key={i}
                  className={`choice ${submitted ? (c.correct ? "correct" : selected?.meaning === c.meaning ? "wrong" : "") : selected?.meaning === c.meaning ? "selected" : ""}`}
                  onClick={() => !submitted && setSelected(c)}>
                  {c.meaning}
                </div>
              ))}
            </div>
          </>
        )}

        {feedback && (
          <div className={`feedback ${feedback.ok === true ? "ok" : feedback.ok === false ? "err" : "neutral"}`}>
            {feedback.msg}
          </div>
        )}
        <div className="btn-row">
          <button className="btn" onClick={skip} disabled={submitted}>跳过</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitted}>提交</button>
        </div>
      </div>
      <ProgressCard done={idx} total={questions.length} />
    </div>
  );
}

// ── History Module ────────────────────────────────────────────────────────────
function HistoryModule({ userId, questions: allQs }) {
  const [phase, setPhase] = useState("warmup");
  const [questions, setQuestions] = useState([]);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [expandedQ, setExpandedQ] = useState({});
  const [prevReview, setPrevReview] = useState(null);

  // Group topics for warmup
  const topics = {};
  allQs.forEach((q) => {
    if (!topics[q.topic]) topics[q.topic] = [];
    topics[q.topic].push(q);
  });

  useEffect(() => {
    if (phase === "test") buildQuestions();
  }, [phase]);

  async function buildQuestions() {
    let wrongToday = [];
    try {
      wrongToday = await db.get("wrong_answers",
        `user_id=eq.${userId}&module=eq.history&scheduled_date=eq.${today()}&resolved=eq.false`);
    } catch {}

    const wrongKeys = new Set((wrongToday || []).map((w) => w.question_key));
    const wrongQs = (wrongToday || []).map((w) => {
      const orig = allQs.find((q) => q.id === w.question_key);
      return orig ? { ...orig, fromWrong: true, wrongId: w.id } : null;
    }).filter(Boolean);

    const rest = shuffle(allQs.filter((q) => !wrongKeys.has(q.id))).slice(0, 5 - wrongQs.length);
    setQuestions([...wrongQs, ...rest]);
    setIdx(0); setSelected(null); setFeedback(null); setSubmitted(false);
  }

  async function submit() {
    if (submitted || selected === null) {
      if (selected === null) setFeedback({ ok: null, msg: "请先选择答案" });
      return;
    }
    const q = questions[idx];
    const isCorrect = selected === q.correct;
    setSubmitted(true);
    setFeedback({ ok: isCorrect, msg: isCorrect ? `✓ 正确！${q.explain}` : `✗ 正确答案：${q.options[q.correct]}　${q.explain}` });

    try {
      if (!isCorrect) {
        await db.post("wrong_answers", {
          user_id: userId, module: "history",
          question_key: q.id,
          question_text: JSON.stringify({ stem: q.stem, options: q.options, correct: q.correct, explain: q.explain, tag: q.grade }),
          my_answer: q.options[selected],
          correct_answer: q.options[q.correct],
          scheduled_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        });
      } else if (q.fromWrong) {
        await db.patch("wrong_answers", `id=eq.${q.wrongId}`, { resolved: true });
      }
    } catch {}

    setTimeout(() => {
      if (idx + 1 >= questions.length) setPhase("review");
      else { setIdx((i) => i + 1); setSelected(null); setFeedback(null); setSubmitted(false); }
    }, 2200);
  }

  function skip() {
    const q = questions[idx];
    setFeedback({ ok: null, msg: `已跳过，答案：${q.options[q.correct]}` });
    setSubmitted(true);
    setTimeout(() => {
      if (idx + 1 >= questions.length) setPhase("review");
      else { setIdx((i) => i + 1); setSelected(null); setFeedback(null); setSubmitted(false); }
    }, 1400);
  }

  if (phase === "warmup") return (
    <div>
      <div className="card">
        <div className="warmup-title">📜 今日预热 · 历史知识点</div>
        {Object.entries(topics).map(([topic, qs]) => (
          <div className="warmup-block" key={topic}>
            <div className="warmup-topic-title">· {topic}</div>
            {qs.map((q) => (
              <div key={q.id} className="warmup-q-item" onClick={() => setExpandedQ((prev) => ({ ...prev, [q.id]: !prev[q.id] }))}>
                <div className="warmup-q-stem">{expandedQ[q.id] ? "▼" : "▶"} {q.stem}</div>
                {expandedQ[q.id] && (
                  <div className="warmup-q-detail">
                    <div className="choice-list" style={{ marginTop: 6 }}>
                      {q.options.map((opt, i) => (
                        <div key={i} className={`choice ${i === q.correct ? "correct" : ""}`}>{opt}</div>
                      ))}
                    </div>
                    <div className="warmup-explain">{q.explain}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        <div className="start-btn-wrap">
          <button className="btn btn-primary" onClick={() => setPhase("test")}>我已熟悉，开始答题 →</button>
        </div>
      </div>
    </div>
  );

  if (phase === "review") return (
    <div>
      <div className="done-banner">🎉 今日历史任务完成！</div>
      <div className="card">
        <div className="warmup-title">📜 回顾今日知识点</div>
        {Object.entries(topics).map(([topic, qs]) => (
          <div className="warmup-block" key={topic}>
            <div className="warmup-topic-title">· {topic}</div>
            <ul className="warmup-points">
              {qs.slice(0, 3).map((q, i) => (
                <li key={i}>{q.explain}</li>
              ))}
            </ul>
          </div>
        ))}
        <div className="start-btn-wrap">
          <button className="btn" onClick={() => setPhase("warmup")}>重新开始</button>
        </div>
      </div>
    </div>
  );

  const q = questions[idx];
  if (!q) return <div className="loading">加载中...</div>;

  return (
    <div>
      <div className="card">
        <div className="section-label">历史真题 · 第 {idx + 1} 题 / {questions.length} 题</div>
        {q.fromWrong && <div className="wrong-tag">错题复习</div>}
        <span className="grade-tag">{q.grade}</span>
        <div className="q-stem">{q.stem}</div>
        <div className="choice-list">
          {q.options.map((opt, i) => (
            <div key={i}
              className={`choice ${submitted ? (i === q.correct ? "correct" : selected === i ? "wrong" : "") : selected === i ? "selected" : ""}`}
              onClick={() => !submitted && setSelected(i)}>
              {opt}
            </div>
          ))}
        </div>
        {feedback && (
          <div className={`feedback ${feedback.ok === true ? "ok" : feedback.ok === false ? "err" : "neutral"}`}>
            {feedback.msg}
          </div>
        )}
        <div className="btn-row">
          {idx > 0 && <button className="btn" onClick={() => setPrevReview(questions[idx - 1])}>上一题</button>}
          <button className="btn" onClick={skip} disabled={submitted}>跳过</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitted}>提交</button>
        </div>
        {prevReview && (
          <div className="prev-review" style={{ marginTop: 12, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>上一题回顾</strong>
              <button className="btn" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => setPrevReview(null)}>收起</button>
            </div>
            <div className="q-stem" style={{ fontSize: 13, marginTop: 6 }}>{prevReview.stem}</div>
            <div style={{ fontSize: 13, color: "#388e3c", marginTop: 4 }}>正确答案：{prevReview.options[prevReview.correct]}</div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{prevReview.explain}</div>
          </div>
        )}
      </div>
      <ProgressCard done={idx} total={questions.length} />
    </div>
  );
}

// ── Wrong Answer Book ─────────────────────────────────────────────────────────
function WrongBook({ userId }) {
  const [wrongs, setWrongs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await db.get("wrong_answers", `user_id=eq.${userId}&order=created_at.desc&limit=100`);
      setWrongs(data || []);
    } catch {}
    setLoading(false);
  }

  const moduleLabel = { poem: "古诗词", word: "单词", history: "历史" };
  const filtered = filter === "all" ? wrongs : wrongs.filter((w) => w.module === filter);
  const unresolved = wrongs.filter((w) => !w.resolved).length;

  function exportWrongs() {
    const lines = filtered.map((w) => `[${moduleLabel[w.module]}] ${w.created_at?.slice(0, 10)}\n题目：${w.correct_answer}\n我的答案：${w.my_answer}\n正确答案：${w.correct_answer}\n${w.resolved ? "已掌握" : "待复习"}\n`);
    const text = `错题本导出 - ${today()}\n${"=".repeat(30)}\n\n${lines.join("\n")}`;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `错题本_${today()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="card">
        <div className="section-label">错题本 · {unresolved} 条待复习</div>
        <div className="filter-row">
          {["all", "poem", "word", "history"].map((f) => (
            <button key={f} className={`filter-btn ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "全部" : moduleLabel[f]}
            </button>
          ))}
        </div>
        {filtered.length > 0 && (
          <button className="btn" style={{ marginBottom: 10, fontSize: 13 }} onClick={exportWrongs}>📥 导出错题</button>
        )}
        {loading ? <div className="loading">加载中...</div> : filtered.length === 0 ? (
          <div className="empty-state">暂无错题 🎉</div>
        ) : filtered.map((w) => (
          <div key={w.id} className={`wrong-item ${w.resolved ? "resolved" : ""}`}>
            <div className="wrong-header">
              <span className="wrong-module">{moduleLabel[w.module]}</span>
              <span className="wrong-date">{w.created_at?.slice(0, 10)}</span>
              {w.resolved && <span className="resolved-tag">已掌握</span>}
            </div>
            <div className="wrong-q">{w.question_key.includes("{") ? "题目" : w.correct_answer}</div>
            <div className="wrong-my">我的答案：{w.my_answer}</div>
            <div className="wrong-correct">正确答案：{w.correct_answer}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Parent View ───────────────────────────────────────────────────────────────
function ParentView({ studentId }) {
  const [sessions, setSessions] = useState([]);
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calSelected, setCalSelected] = useState(null);
  const [tab, setTab] = useState("stats"); // stats | manage

  useEffect(() => { loadSessions(); }, []);

  async function loadSessions() {
    try {
      const data = await db.get("daily_sessions", `user_id=eq.${studentId}&order=session_date.desc&limit=60`);
      setSessions(data || []);
    } catch {}
  }

  const last7 = sessions.slice(0, 7);
  const avgAcc = last7.length ? Math.round(last7.reduce((s, r) => s + (r.accuracy || 0), 0) / last7.length) : 0;
  const totalQ = sessions.reduce((s, r) => s + (r.total_questions || 0), 0);
  const streak = (() => {
    let s = 0;
    const d = new Date();
    for (const session of sessions) {
      const sd = new Date(session.session_date);
      const diff = Math.round((d - sd) / 86400000);
      if (diff === s) s++;
      else break;
    }
    return s;
  })();

  // Calendar
  const sessionMap = {};
  sessions.forEach((s) => { sessionMap[s.session_date] = s; });

  const months = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  function dayClass(d) {
    const key = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const s = sessionMap[key];
    if (!s) return "cal-day";
    if (s.accuracy >= 80) return "cal-day good";
    if (s.accuracy >= 60) return "cal-day mid";
    return "cal-day bad";
  }

  function selectDay(d) {
    const key = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    setCalSelected(sessionMap[key] ? { ...sessionMap[key], label: `${calYear}年${calMonth + 1}月${d}日` } : null);
  }

  const moduleLabel = { poem: "古诗词", word: "单词", history: "历史" };
  const modStats = ["poem", "word", "history"].map((m) => {
    const ms = sessions.filter((s) => s.module === m);
    const acc = ms.length ? Math.round(ms.reduce((s, r) => s + (r.accuracy || 0), 0) / ms.length) : 0;
    return { module: m, acc };
  });

  return (
    <div className="main">
      <div className="tab-bar">
        <button className={`tab ${tab === "stats" ? "active" : ""}`} onClick={() => setTab("stats")}>学习报告</button>
        <button className={`tab ${tab === "manage" ? "active" : ""}`} onClick={() => setTab("manage")}>内容管理</button>
      </div>

      {tab === "stats" && (
        <>
          <div className="stat-grid">
            <div className="stat-card"><div className="stat-num">{streak}</div><div className="stat-lbl">连续打卡</div></div>
            <div className="stat-card"><div className="stat-num">{avgAcc}%</div><div className="stat-lbl">近7天正确率</div></div>
            <div className="stat-card"><div className="stat-num">{totalQ}</div><div className="stat-lbl">累计题数</div></div>
          </div>

          <div className="card">
            <div className="section-label">各模块正确率</div>
            {modStats.map((m) => (
              <div className="mod-row" key={m.module}>
                <span className="mod-name">{moduleLabel[m.module]}</span>
                <div className="mod-bar-wrap"><div className="mod-bar" style={{ width: `${m.acc}%` }} /></div>
                <span className="mod-pct">{m.acc}%</span>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="cal-header">
              <button className="cal-nav" onClick={() => { if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); } else setCalMonth(m => m - 1); }}>‹</button>
              <div className="cal-title">{calYear}年{months[calMonth]}</div>
              <button className="cal-nav" onClick={() => { if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); } else setCalMonth(m => m + 1); }}>›</button>
            </div>
            <div className="cal-grid">
              {["日","一","二","三","四","五","六"].map((d) => <div key={d} className="cal-dow">{d}</div>)}
              {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const d = i + 1;
                return <div key={d} className={dayClass(d)} onClick={() => selectDay(d)}>{d}</div>;
              })}
            </div>
            {calSelected && (
              <div className="cal-detail">
                <div className="cal-detail-title">{calSelected.label}</div>
                <div className="cal-detail-row">
                  <span>正确率</span>
                  <strong style={{ color: calSelected.accuracy >= 80 ? "var(--color-text-success)" : calSelected.accuracy >= 60 ? "var(--color-text-warning)" : "var(--color-text-danger)" }}>
                    {Math.round(calSelected.accuracy)}%
                  </strong>
                </div>
                <div className="cal-detail-row"><span>题目数</span><strong>{calSelected.total_questions}</strong></div>
                <div className="cal-detail-row"><span>正确数</span><strong>{calSelected.correct_count}</strong></div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="section-label">近七天记录</div>
            {last7.length === 0 && <div className="empty-state">暂无记录</div>}
            {last7.map((s) => (
              <div key={s.id} className="day-row">
                <span>{s.session_date}</span>
                <span className="day-module">{moduleLabel[s.module]}</span>
                <span className={`badge ${s.accuracy >= 80 ? "badge-g" : s.accuracy >= 60 ? "badge-a" : "badge-r"}`}>
                  {Math.round(s.accuracy)}%
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "manage" && <ContentManager />}
    </div>
  );
}

// ── Content Manager ───────────────────────────────────────────────────────────
function ContentManager() {
  const [msg, setMsg] = useState({});

  async function upload(type, file) {
    setMsg((m) => ({ ...m, [type]: "上传中..." }));
    try {
      const text = await file.text();
      let content;
      if (file.name.endsWith(".json")) {
        content = JSON.parse(text);
      } else if (file.name.endsWith(".txt")) {
        // txt格式: 每行 word\t中文意思 (单词库) 或纯诗词文本
        if (type === "words") {
          content = text.split("\n").filter(Boolean).map((line) => {
            const [word, meaning] = line.split("\t");
            return { word: word?.trim(), meaning: meaning?.trim() };
          }).filter((w) => w.word && w.meaning);
        } else {
          throw new Error("诗词和历史题库请使用 JSON 格式");
        }
      } else {
        throw new Error("请上传 .json 或 .txt 文件");
      }

      // Get current version
      const existing = await db.get("content_library", `type=eq.${type}&order=version.desc&limit=1`);
      const version = (existing?.[0]?.version || 0) + 1;
      await db.post("content_library", { type, content, version, uploaded_at: new Date().toISOString() });
      setMsg((m) => ({ ...m, [type]: `✓ 上传成功！版本 v${version}，共 ${Array.isArray(content) ? content.length : "?"} 条` }));
    } catch (e) {
      setMsg((m) => ({ ...m, [type]: `✗ 失败：${e.message}` }));
    }
  }

  const sections = [
    { type: "poems", label: "古诗词库", desc: "JSON格式，数组，每项含 id/title/author/dynasty/grade/lines", accept: ".json" },
    { type: "words", label: "单词库", desc: "JSON格式（[{word,meaning}]）或TXT格式（每行: word\\t中文意思）", accept: ".json,.txt" },
    { type: "history", label: "历史题库", desc: "JSON格式，数组，每项含 id/grade/topic/stem/options/correct/explain", accept: ".json" },
  ];

  return (
    <div>
      {sections.map((s) => (
        <div className="card" key={s.type}>
          <div className="section-label">{s.label}</div>
          <div className="manage-desc">{s.desc}</div>
          <label className="upload-label">
            <input type="file" accept={s.accept} style={{ display: "none" }}
              onChange={(e) => e.target.files[0] && upload(s.type, e.target.files[0])} />
            <span className="btn">📂 选择文件并上传（整库替换）</span>
          </label>
          {msg[s.type] && (
            <div className={`manage-msg ${msg[s.type].startsWith("✓") ? "ok" : msg[s.type].startsWith("✗") ? "err" : ""}`}>
              {msg[s.type]}
            </div>
          )}
        </div>
      ))}
      <div className="card">
        <div className="section-label">格式说明</div>
        <div className="manage-desc">
          <strong>单词 TXT 格式示例：</strong><br />
          water	水<br />
          fire	火<br />
          <br />
          <strong>诗词 JSON 格式示例：</strong><br />
          {`[{"id":"p001","title":"观沧海","author":"曹操","dynasty":"东汉","grade":"初一上","lines":["东临碣石，以观沧海。","水何澹澹，山岛竦峙。"]}]`}
          <br /><br />
          <strong>历史题 JSON 格式示例：</strong><br />
          {`[{"id":"h001","grade":"初一上","topic":"夏商周","stem":"题干（   ）","options":["A.","B.","C.","D."],"correct":0,"explain":"解析"}]`}
        </div>
      </div>
    </div>
  );
}

// ── Shared Components ─────────────────────────────────────────────────────────
function ProgressCard({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="card">
      <div className="section-label">今日进度</div>
      <div className="progress-wrap"><div className="progress-bar" style={{ width: `${pct}%` }} /></div>
      <div className="prog-label">{done} / {total} 完成</div>
    </div>
  );
}

// ── App Shell ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("poem");
  const [poems, setPoems] = useState(poemsData);
  const [words, setWords] = useState(wordsData);
  const [history, setHistory] = useState(historyData);
  const [studentId, setStudentId] = useState(null);

  // Load latest content from DB on mount
  useEffect(() => {
    if (!user) return;
    loadContent();
    // Find student user id
    if (user.role === "parent") {
      db.get("users", "role=eq.student&select=id").then((rows) => {
        if (rows?.[0]) setStudentId(rows[0].id);
      }).catch(() => {});
    }
  }, [user]);

  async function loadContent() {
    for (const type of ["poems", "words", "history"]) {
      try {
        const rows = await db.get("content_library", `type=eq.${type}&order=version.desc&limit=1`);
        if (rows?.[0]?.content) {
          if (type === "poems") setPoems(rows[0].content);
          if (type === "words") setWords(rows[0].content);
          if (type === "history") setHistory(rows[0].content);
        }
      } catch {}
    }
  }

  if (!user) return <LoginScreen onLogin={setUser} />;

  if (user.role === "parent") return (
    <div className="app">
      <TopBar title="📊 学习报告" sub="家长查看" right={<button className="role-btn" onClick={() => setUser(null)}>退出</button>} />
      <ParentView studentId={studentId || user.id} />
    </div>
  );

  return (
    <div className="app">
      <TopBar title="📚 每日学习" sub="今日任务 · 预计15分钟"
        right={<button className="role-btn" onClick={() => setUser(null)}>退出</button>} />
      <div className="main">
        <div className="tab-bar">
          {[["poem","古诗词"],["word","单词"],["history","历史"],["wrong","错题本"]].map(([t,l]) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
        {tab === "poem" && <PoemModule userId={user.id} poems={poems} />}
        {tab === "word" && <WordModule userId={user.id} words={words} />}
        {tab === "history" && <HistoryModule userId={user.id} questions={history} />}
        {tab === "wrong" && <WrongBook userId={user.id} />}
      </div>
    </div>
  );
}

function TopBar({ title, sub, right }) {
  return (
    <div className="topbar">
      <div><div className="topbar-title">{title}</div><div className="topbar-sub">{sub}</div></div>
      {right}
    </div>
  );
}
