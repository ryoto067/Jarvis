// J.A.R.V.I.S. ローカルサーバー（自分のPCからのみアクセス可能）
// 起動: node server.js  →  http://127.0.0.1:8765
// 頭脳はこのPCの Claude Code。拠点フォルダ（Desktop\claude）で起動し、ふだんの Claude Code と同じことが全部できる
// （ファイル操作・コマンド・Gmail / カレンダー / Drive / Slack / Notion・エージェント・スキル）。API キー不要・追加料金なし
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8765;
const HOST = '127.0.0.1'; // 外部（他の端末）からは接続できない
const ORIGIN = `http://${HOST}:${PORT}`;
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8' };
const PUBLIC = new Set(['/index.html']); // 配信してよいファイル

// Claude Code 本体の場所（npm で入れた場合）。見つからなければ PATH の claude を使う
const CLAUDE_EXE = [
  path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
].find(p => fs.existsSync(p)) || 'claude';
// 作業場所：Claude 関連の仕事の拠点フォルダ（CLAUDE.md・エージェント・スキルがそのまま効く）
// このフォルダから上へたどり、CLAUDE.md と .claude/agents がある場所を拠点とみなす（フォルダを移動しても動く）
const WORK_DIR = (() => {
  for (let dir = path.dirname(ROOT); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) && fs.existsSync(path.join(dir, '.claude', 'agents'))) return dir;
  }
  return path.join(process.env.USERPROFILE || '', 'Desktop', 'claude');
})();

// Claude Code の標準の指示に「追加」する、ジャービスとしての話し方のルール
const JARVIS_PROMPT = `# 音声アシスタント「ジャービス」として動く
オーナーはブラウザの音声インターフェース「ジャービス」から、声であなた（Claude Code）を操作している。あなたの返答テキストはそのまま音声で読み上げられる。
ふだんの Claude Code と同じように、ファイル操作・コマンド・MCP（Gmail、Googleカレンダー、Google Drive、Slack、Notion など）・エージェント・スキルを使って、頼まれたことを最後までやり遂げてよい。

## 会話の始めに必ずやること
- 新しい会話の最初の発言を受けたら、返答する前に拠点フォルダの CLAUDE.md と README.md を読み、さらに projects フォルダの各プロジェクトの README や引き継ぎメモ（あれば）にざっと目を通して、全体の状況を頭に入れておく。読んだ内容は聞かれない限り報告しない。

## 話し方
- 英国の執事のように丁寧で落ち着いた口調。ときどき控えめで知的なユーモア。
- 日本語の話し言葉で、1回の返答は基本1〜3文、長くても200文字程度。
- マークダウン、箇条書き、表、記号、絵文字、URL、ファイルパスは書かない。読み上げて自然な文だけにする。一覧は「全部で8つで、主なものは〜です」のように言葉でまとめる。
- 作業に時間がかかりそうなときは、最初に「〜を確認します」のような短い一文だけ言ってから作業し、終わったら結果を1〜3文で報告する。途中経過の独り言は書かない。
- 天気・ニュースなど最新情報は WebSearch で調べる。地域が分からない天気は東京として答える。出典や Sources の一覧は書かない。

## 音声ならではの注意
- オーナーの発言は音声認識の結果なので、誤変換がありえる。意図が読み取れれば推測して進め、重要な部分が曖昧なら短く聞き返す。
- 発言の先頭の（ ）内は現在の日時。
- 外部の人に届く操作（メール・Slack 送信、SNS 投稿など）、削除・上書き、公開、支払いの前には、必ず内容（宛先・本文の要点・対象）を読み上げて「よろしいですか？」と確認し、次の発言で「はい」「お願い」などの承認を得てから実行する。聞き間違いの可能性があるので、承認が曖昧なら実行しない。

## 動作タグ（読み上げられない。必要なときだけ返答の最後に付ける）
- ブラウザでウェブページを開いてほしいと頼まれたら [[OPEN:https://...]] を付ける。
- 会話を終えるのはオーナーが「終了」と言ったときだけ（画面側で処理する）。[[SLEEP]] は付けない。`;

/* ===== 秘書モード：パーソナル秘書システム（~/.secretary）と連携する ===== */
const SECRETARY_DIR = path.join(process.env.USERPROFILE || '', '.secretary');
const HAS_SECRETARY = fs.existsSync(path.join(SECRETARY_DIR, 'CLAUDE.md'));
// 秘書システムの運用ルール（CLAUDE.md）は起動時に読み込んで、そのまま指示に含める
const SECRETARY_RULES = HAS_SECRETARY ? fs.readFileSync(path.join(SECRETARY_DIR, 'CLAUDE.md'), 'utf8') : '';
const SECRETARY_PROMPT = HAS_SECRETARY ? `

# 秘書としての役割
あなたはオーナー専属のパーソナル秘書でもある。秘書システムの本体は ${SECRETARY_DIR}（以下「秘書フォルダ」）。
タスク・メモ・予定・振り返りなど身の回りの管理は、すべて秘書フォルダに対して行う（拠点フォルダの各プロジェクトの仕事は、従来どおり拠点の CLAUDE.md に従う）。
ファイル形式・テンプレート・追記ルールは、下の「秘書システムのルール」に従う。秘書フォルダへの追記は確認なしでよいが、削除・上書き・外部送信は確認する。

## 声での頼まれ方と動き方
- 「おはよう」「ブリーフィング」「今日はどんな感じ？」: 朝の報告をする。今日の日付と曜日、Google カレンダーの今日の予定、今日のタスク（今日の TODO ファイル。なければ直近の TODO ファイルの未完了を引き継いで今日のファイルを作るか聞く）、Gmail の未読で返信が必要そうなもの（件数と差出人・用件の要点だけ）。全体で読み上げ30秒程度に収める。
- 「タスク追加〇〇」「〇〇やらなきゃ」「〇〇をやることに入れて」: 今日の TODO ファイルに追記する（なければテンプレートから作る）。優先度・期限が言われなければ通常・期限なし。クライアント名やプロジェクト名が分かれば添える。追加したら内容を一言で復唱する。
- 「今日のタスク」「何からやればいい？」: 今日の TODO とカレンダーを見て、優先度の高い順に3つほど読み上げ、残りは件数だけ伝える。おすすめの順番を一言添える。
- 「〇〇終わった」「〇〇完了」: 該当タスクを完了にして完了日を付ける。どのタスクか曖昧なら聞き返す。
- 「メモ〇〇」「覚えておいて」「思いついたんだけど」: inbox に時刻付きで追記する。
- 「アイデア〇〇」「調べておいて〇〇」: アイデアは ideas、調査は research にテンプレートから作る。調査は WebSearch で調べて要点を書き込み、結論だけ読み上げる。
- 「予定入れて」: Google カレンダーに入れる前に、日時とタイトルを復唱して確認する。招待する人がいる場合は外部に届く操作として扱う。
- 「今日の振り返り」「今日はもう終わり」: 今日の TODO の完了・未完了を報告し、未完了を明日に回すか聞く。そのあと学びメモの3つの質問を1問ずつ聞き、オーナーの言葉のまま学びメモに書く（代わりに書きすぎない）。
- 「週次レビュー」「ダッシュボード」「受信箱整理」「学びメモ」「なぜメモ」「学び振り返り」: 秘書システムのクイックコマンドどおりに動く。
- 打ち合わせの話が出たら、アクションアイテムを meetings に書き、自分の担当分を TODO にも転記する。

# 秘書システムのルール（${SECRETARY_DIR}\\CLAUDE.md）
${SECRETARY_RULES}` : '';

/* ===== Claude Code をつなぎっぱなしにして、発言を順番に送る ===== */
const brain = {
  child: null,      // 実行中の claude プロセス
  sessionId: null,  // 会話の ID（作業を中止して再起動しても、続きから話せる）
  busy: false,      // 返答中かどうか
  listener: null,   // 返答を受け取っているブラウザ
  buf: '',
};

function startBrain() {
  if (brain.child) return;
  const args = [
    '-p', '--input-format', 'stream-json',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'auto', // ほぼ全部できる。明らかに危険な操作だけ Claude Code 側で止まる
    '--append-system-prompt', JARVIS_PROMPT + SECRETARY_PROMPT,
  ];
  if (HAS_SECRETARY) args.push('--add-dir', SECRETARY_DIR); // 秘書フォルダも作業範囲に入れる
  if (brain.sessionId) args.push('--resume', brain.sessionId);
  const child = spawn(CLAUDE_EXE, args, { cwd: WORK_DIR, windowsHide: true });
  brain.child = child; brain.buf = '';

  child.stdout.on('data', d => {
    brain.buf += d;
    const lines = brain.buf.split('\n'); brain.buf = lines.pop();
    for (const line of lines) { let ev; try { ev = JSON.parse(line); } catch { continue; } onEvent(ev); }
  });
  child.stderr.on('data', d => console.error('[claude]', String(d).trim().slice(0, 300)));
  child.on('error', err => console.error('[claude] 起動できません:', err.message));
  child.on('close', () => {
    if (brain.child !== child) return;
    brain.child = null;
    if (brain.busy) finishTurn({ error: 'Claude Code が途中で終了しました' });
  });
}

function emit(obj) { if (brain.listener) brain.listener.write(JSON.stringify(obj) + '\n'); }
function finishTurn(last) {
  if (last) emit(last);
  emit({ done: true });
  if (brain.listener) brain.listener.end();
  brain.listener = null; brain.busy = false;
}

function onEvent(ev) {
  if (ev.type === 'system' && ev.subtype === 'init') { brain.sessionId = ev.session_id; return; }
  if (ev.type === 'stream_event') {
    const e = ev.event;
    if (ev.parent_tool_use_id) return; // サブエージェント内部の出力は読み上げない
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') emit({ text: e.delta.text });
    if (e.type === 'content_block_start' && /tool_use/.test(e.content_block?.type || '')) emit({ tool: e.content_block.name });
    if (e.type === 'message_start') emit({ text: '\n' }); // 前の文と混ざらないよう区切る
    return;
  }
  if (ev.type === 'result') {
    if (ev.permission_denials?.length) console.log('[許可されなかった操作]', JSON.stringify(ev.permission_denials).slice(0, 300));
    finishTurn(ev.is_error ? { error: String(ev.result || ev.subtype).slice(0, 200) } : null);
  }
}

const CANCEL = /中止|ストップ|キャンセル|止めて|やめて/;

async function handleChat(req, res) {
  // 他のサイトからこのサーバーを勝手に呼ばれないようにする
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) { res.writeHead(403); return res.end(); }
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1e6) { res.writeHead(413); return res.end(); } }
  let text;
  try { text = String(JSON.parse(body).text || '').trim(); if (!text) throw 0; } catch { res.writeHead(400); return res.end(); }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const reply = t => { res.write(JSON.stringify({ text: t }) + '\n'); res.end(JSON.stringify({ done: true }) + '\n'); };

  if (brain.busy) {
    if (CANCEL.test(text)) { cancelBrain(); return reply('作業を中止しました。'); }
    return reply('ただいま別の作業を進めております。中止する場合は「中止」とおっしゃってください。');
  }
  startBrain();
  brain.busy = true; brain.listener = res;
  // ブラウザとの接続が切れても作業は続ける（結果は読み上げられないが、作業自体は完了させる）
  res.on('close', () => { if (brain.listener === res) brain.listener = null; });
  brain.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
}

function cancelBrain() {
  const child = brain.child;
  if (brain.busy) finishTurn(null);
  brain.child = null; brain.busy = false;
  if (child) child.kill();
}

function resetBrain() { cancelBrain(); brain.sessionId = null; startBrain(); }

/* ===== VOICEVOX（PC内の音声エンジン）===== */
const VV = 'http://127.0.0.1:50021';
const VV_ENGINE = [
  // winget で入れた場合（YouTube の自動作成と同じエンジン）
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages/HiroshibaKazuyuki.VOICEVOX_Microsoft.Winget.Source_8wekyb3d8bbwe/VOICEVOX/vv-engine/run.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs/VOICEVOX/vv-engine/run.exe'),
  path.join(process.env.ProgramFiles || '', 'VOICEVOX/vv-engine/run.exe'),
].find(p => fs.existsSync(p));
let vvStarting = null;

async function vvAlive() {
  try { return (await fetch(VV + '/version', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
// エンジンが動いていなければ裏で起動する（VOICEVOX アプリを開かなくてよい）
function ensureVoicevox() {
  if (vvStarting) return vvStarting;
  vvStarting = (async () => {
    if (await vvAlive()) return true;
    if (!VV_ENGINE) return false;
    console.log('VOICEVOX エンジンを起動しています…');
    spawn(VV_ENGINE, ['--host', '127.0.0.1', '--port', '50021'],{ cwd: path.dirname(VV_ENGINE), detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 500)); if (await vvAlive()) return true; }
    return false;
  })();
  vvStarting.then(ok => { if (!ok) vvStarting = null; });
  return vvStarting;
}

async function handleVoices(req, res) {
  if (!(await ensureVoicevox())) { res.writeHead(503); return res.end('[]'); }
  const speakers = await (await fetch(VV + '/speakers')).json();
  const list = speakers.flatMap(s => s.styles.filter(st => !st.type || /talk/.test(st.type)) /* 歌唱用は除く */.map(st => ({ id: st.id, name: s.name, style: st.name })));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(list));
}

async function handleTts(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) { res.writeHead(403); return res.end(); }
  let body = '';
  for await (const chunk of req) body += chunk;
  let text, speaker;
  try { ({ text, speaker } = JSON.parse(body)); speaker = Number(speaker); if (!text || !Number.isInteger(speaker)) throw 0; }
  catch { res.writeHead(400); return res.end(); }
  try {
    if (!(await ensureVoicevox())) throw new Error('VOICEVOX が見つかりません');
    const q = await fetch(`${VV}/audio_query?speaker=${speaker}&text=${encodeURIComponent(String(text).slice(0, 500))}`, { method: 'POST' });
    if (!q.ok) throw new Error('audio_query ' + q.status);
    const query = await q.json();
    query.speedScale = 1.1;        // 少しテンポよく
    query.prePhonemeLength = 0.05; // 文の頭の無音を短く
    query.postPhonemeLength = 0.1;
    const s = await fetch(`${VV}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
    if (!s.ok) throw new Error('synthesis ' + s.status);
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.from(await s.arrayBuffer()));
  } catch (err) {
    console.error('[tts error]', err.message);
    res.writeHead(502); res.end();
  }
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (urlPath === '/api/voices') return handleVoices(req, res).catch(() => { res.writeHead(503); res.end('[]'); });
  if (urlPath === '/api/tts' && req.method === 'POST') return handleTts(req, res);
  if (urlPath === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ai: true })); }
  // 新しい会話を始める（画面の INITIALIZE を押したとき）
  if (urlPath === '/api/reset' && req.method === 'POST') {
    if (req.headers.origin && req.headers.origin !== ORIGIN) { res.writeHead(403); return res.end(); }
    resetBrain(); res.writeHead(204); return res.end();
  }

  const rel = urlPath === '/' ? '/index.html' : urlPath;
  if (!PUBLIC.has(rel)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, rel), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, HOST, () => {
  console.log(`J.A.R.V.I.S. online → ${ORIGIN}  (頭脳: Claude Code / 作業場所: ${WORK_DIR})`);
  startBrain(); // 先に起動しておき、最初の返事を速くする
  ensureVoicevox().then(ok => console.log(ok ? '声: VOICEVOX 準備OK' : '声: VOICEVOX なし → Windows の声を使います'));
});
