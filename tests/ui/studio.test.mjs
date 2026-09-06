import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from './.deps/node_modules/playwright/index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.join(ROOT, 'tests/ui/.artifacts');
// Loopback is a secure context for browser crypto/media APIs. Every request is fulfilled
// by Playwright routing: nothing listens on this port and no server is started.
const ORIGIN = 'http://127.0.0.1:3999';
const initial = () => ({ id: 'project-one', revision: 1, title: '我的纸上故事', story: '', credits: { director: '', voice: '' },
  characters: [{ id: 'hero', name: '纸偶', color: '#ac4866' }, { id: 'clock', name: '时钟', color: '#317a72' }],
  scenes: [], assets: [], recordingAssetId: null, alignment: null, exports: [], edits: [], style: { width: 1280, height: 960, fps: 25, introSeconds: 3, outroSeconds: 4 } });
function syntheticPng() {
  // CC0 anonymous geometric puppet, encoded with Node builtins; no downloaded/private image.
  const width = 300, height = 240, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let rgb = y > 180 ? [127, 168, 115] : [242, 224, 182];
    if ((x - 245) ** 2 + (y - 49) ** 2 < 32 ** 2) rgb = [243, 195, 77];
    if (y > 90 && y < 210 && Math.abs(x - 90) < (y - 65) * .4) rgb = [67, 137, 194];
    if ((x - 90) ** 2 + (y - 75) ** 2 < 25 ** 2) rgb = [255, 246, 220];
    if ((x - 82) ** 2 + (y - 74) ** 2 < 2 ** 2 || (x - 99) ** 2 + (y - 74) ** 2 < 2 ** 2) rgb = [53, 57, 69];
    if (x > 205 && x < 246 && y > 120 && y < 185) rgb = [182, 119, 76];
    if ((x - 226) ** 2 + (y - 143) ** 2 < 14 ** 2) rgb = [255, 246, 220];
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    raw[offset] = rgb[0]; raw[offset + 1] = rgb[1]; raw[offset + 2] = rgb[2];
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type), all = Buffer.concat([name, data]); let crc = 0xffffffff;
    for (const byte of all) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); all.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function wav() {
  const rate = 8000, count = rate * 4, data = Buffer.alloc(44 + count * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + count * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 330 / rate) * 2000), 44 + i * 2);
  return data;
}
async function setup(browser, synthesizeMicrophone = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  if (synthesizeMicrophone) await context.addInitScript(() => {
    // Real browser MediaRecorder receives a generated oscillator stream, never a microphone.
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const audio = new AudioContext();
      const source = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
      source.frequency.value = 440; gain.gain.value = .1; source.connect(gain); gain.connect(destination); source.start();
      await audio.resume(); window.syntheticAudioContext = audio; return destination.stream;
    } });
  });
  const page = await context.newPage();
  const state = { project: null, jobs: [], requests: [], errors: [], conflict: false, serial: 0, keepRunning: false,
    review: { agent: { liveStatus: 'cold', lastTurnReason: null, messages: [] }, proposals: [] }, rejectConfirm: false, reviewConflict: false,
    agentError: false, health: { render: { ready: true }, alignment: { configured: false, engine: '' }, agent: { configured: false }, narration: { configured: false }, worker: { available: true, missing: [] } } };
  page.on('pageerror', error => state.errors.push(error.message));
  state.dialogs = []; state.confirmAnswers = [];
  page.on('dialog', dialog => {
    state.dialogs.push(dialog.message());
    const accept = state.confirmAnswers.length ? state.confirmAnswers.shift() : !state.rejectConfirm;
    return accept ? dialog.accept() : dialog.dismiss();
  });
  const png = syntheticPng();
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    const pathname = url.pathname;
    if (pathname === '/paper-director/' || pathname.startsWith('/paper-director/static/')) {
      const name = pathname === '/paper-director/' ? 'index.html' : pathname.split('/').at(-1);
      if (!['index.html', 'studio.js', 'studio.css'].includes(name)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(path.join(ROOT, 'web', name)) });
    }
    const endpoint = pathname.replace('/paper-director/api', '');
    const method = request.method();
    let body = null;
    if (request.headers()['content-type']?.includes('application/json')) body = request.postDataJSON();
    state.requests.push({ endpoint, method, body, headers: request.headers(), bytes: request.postDataBuffer()?.length });
    const ok = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
    const error = (code, status = 400) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code, message: 'Untrusted internal C:/secret/key path must not be displayed' } }) });
    if (endpoint === '/health') return ok(state.health);
    if (endpoint === '/projects' && method === 'GET') return ok(state.project ? [state.project] : []);
    if (endpoint === '/projects' && method === 'POST') { state.project = initial(); return ok(state.project); }
    if (endpoint === '/projects/project-one' && method === 'GET') return ok(state.project);
    if (endpoint === '/projects/project-one' && method === 'PATCH') {
      if (state.conflict) { state.conflict = false; state.project.title = '另一处保存的新版本'; state.project.revision++; return error(state.conflictCode || 'REVISION_CONFLICT', 409); }
      if (body.expectedRevision !== state.project.revision) return error('REVISION_CONFLICT', 409);
      Object.assign(state.project, body.patch); state.project.revision++;
      if (['scenes', 'characters', 'recordingAssetId'].some(key => key in body.patch)) state.project.alignment = null;
      return ok(state.project);
    }
    if (endpoint === '/projects/project-one/assets' && method === 'POST') {
      if (Number(request.headers()['x-project-revision']) !== state.project.revision) return error('REVISION_CONFLICT', 409);
      if (state.uploadFailure) { state.uploadFailure = false; return error('UPLOAD_FAILED', 503); }
      const kind = request.headers()['x-asset-kind'];
      const asset = { id: `asset-${++state.serial}`, kind, name: decodeURIComponent(request.headers()['x-file-name']), mime: request.headers()['content-type'], metadata: kind === 'audio' ? { duration: 4 } : { width: 300, height: 240 } };
      state.project.assets.push(asset); state.project.revision++;
      return ok({ project: state.project, asset });
    }
    if (endpoint.startsWith('/projects/project-one/assets/')) {
      const asset = state.project.assets.find(a => a.id === endpoint.split('/').at(-1));
      const buffer = asset?.kind === 'audio' ? wav() : png;
      const range = request.headers().range;
      if (range) { const start = Number(range.match(/bytes=(\d+)/)?.[1] || 0); return route.fulfill({ status: 206, headers: { 'Content-Type': asset?.mime || 'image/png', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${buffer.length - 1}/${buffer.length}` }, body: buffer.subarray(start) }); }
      return route.fulfill({ status: 200, headers: { 'Content-Type': asset?.mime || 'image/png', 'Accept-Ranges': 'bytes' }, body: buffer });
    }
    if (endpoint === '/jobs') {
      for (const job of state.jobs) if (job.status === 'running' && !state.keepRunning) {
        job.status = 'succeeded'; job.progress = 1;
        if (job.kind === 'align') {
          const segments = job.segments || state.project.scenes.flatMap(s => s.dialogue.map((d, i) => ({ dialogueId: d.id, start: i, end: i + .6, text: d.text })));
          state.project.alignment = { method: job.segments ? 'provided_segments' : 'local_whisper', duration: 4,
            utterances: state.project.scenes.flatMap(s => s.dialogue.map(d => { const part = segments.find(v => v.dialogueId === d.id); return { dialogueId: d.id, sceneId: s.id, characterId: d.characterId, recognizedText: part?.text || '', start: part?.start ?? null, end: part?.end ?? null, matchStatus: part ? 'matched' : 'unmatched' }; })),
            unmatchedSpeech: segments.filter(s => !s.dialogueId), warnings: ['Provided transcript is not ASR'] };
        } else if (job.kind === 'render') {
          const asset = { id: `movie-${++state.serial}`, kind: 'video', mime: 'video/mp4', metadata: {} };
          state.project.assets.push(asset); job.result = { assetId: asset.id, preview: true, inputRevision: job.revision, applied: true };
          state.project.exports.push(job.result);
        }
        state.project.revision++;
      }
      return ok(state.jobs);
    }
    if (/\/jobs\/[^/]+\/cancel$/.test(endpoint)) { const job = state.jobs.find(j => endpoint.includes(j.id)); job.status = 'cancelled'; return ok(job); }
    if (/\/projects\/project-one\/(align|render)$/.test(endpoint)) {
      const kind = endpoint.split('/').at(-1), job = { id: `job-${++state.serial}`, projectId: state.project.id, kind, revision: body.expectedRevision, status: 'running', progress: .2, stage: 'working', result: null, error: null };
      if (body.segments) job.segments = body.segments;
      state.jobs.unshift(job); return ok(job);
    }
    if (endpoint === '/projects/project-one/review') return ok({ projectId: state.project.id, revision: state.project.revision, ...state.review });
    if (endpoint.startsWith('/projects/project-one/reviews/')) {
      if (state.reviewConflict || body.expectedRevision !== state.project.revision) {
        state.reviewConflict = false; state.project.revision++; state.project.title = '服务器上的新标题'; state.review.proposals = [];
        return error('REVISION_CONFLICT', 409);
      }
      assert.deepEqual(Object.keys(body).sort(), ['decision', 'expectedRevision']);
      state.review.proposals = state.review.proposals.filter(p => p.id !== endpoint.split('/').at(-1));
      if (body.decision === 'apply') state.project.revision++;
      return ok(state.project);
    }
    if (endpoint === '/projects/project-one/agent') return state.agentError ? error('AGENT_NOT_CONFIGURED') : ok({ sessionId: 'agent-session-one' });
    if (endpoint.endsWith('/history')) return ok([{ revision: state.project.revision }, { revision: 1 }]);
    if (endpoint.endsWith('/restore')) { state.project.title = '恢复的第一部故事'; state.project.revision++; return ok(state.project); }
    return error('NOT_FOUND', 404);
  });
  await page.goto(ORIGIN + '/paper-director/');
  await page.locator('#new-project').waitFor();
  return { page, context, state, png };
}

await mkdir(OUT, { recursive: true });
const launch = process.env.PAPER_DIRECTOR_BROWSER ? { executablePath: process.env.PAPER_DIRECTOR_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {};
const browser = await chromium.launch({ ...launch, headless: true, args: ['--disable-background-networking'] });

test('child studio: authored story → ordered photos → ONE recording → explicit manual markers → actual jobs and feedback', async () => {
  const { page, context, state, png } = await setup(browser);
  await page.locator('#new-project').click();
  await page.locator('#editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#agent-create').isDisabled(), true);
  assert.equal(await page.locator('#auto-align').isDisabled(), true);
  await page.locator('#title').fill('纸偶与时间之门');
  await page.locator('#story').fill('纸偶寻找时钟里的秘密，打开一扇时间门。');
  await page.locator('#director').fill('匿名小导演');
  await page.locator('#voice').fill('合成演示');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  assert.equal(state.project.title, '纸偶与时间之门');
  await page.waitForFunction(() => !document.getElementById('photo-files').disabled);
  await page.locator('#photo-files').setInputFiles([{ name: 'anonymous-a.png', mimeType: 'image/png', buffer: png }, { name: 'anonymous-b.png', mimeType: 'image/png', buffer: png }]);
  await page.waitForFunction(() => document.querySelectorAll('.scene').length === 2 && !document.getElementById('photo-files').disabled);
  const originalIds = state.project.scenes.map(s => s.id);
  await page.getByRole('button', { name: '第2幕向前移' }).click();
  const firstScene = page.locator('.scene').first();
  await firstScene.getByRole('button', { name: '＋ 加一句台词' }).click();
  await firstScene.getByLabel('这句台词', { exact: true }).fill('时间之门在哪里？');
  await firstScene.getByLabel('怎么说').selectOption('thought');
  await firstScene.getByLabel('这里发生了什么动作？').fill('轻轻打开时钟的小门。');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  assert.deepEqual(state.project.scenes.map(s => s.id), originalIds.toReversed());
  const dialogueId = state.project.scenes[0].dialogue[0].id;
  assert.match(dialogueId, /^[A-Za-z0-9_-]+$/);
  await page.waitForFunction(() => !document.getElementById('audio-file').disabled);
  await page.locator('#audio-file').setInputFiles({ name: 'anonymous-tones.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.waitForFunction(() => !document.getElementById('recording-player').hidden && !document.getElementById('audio-file').disabled);
  assert.ok(state.project.recordingAssetId);
  const audioPatches = state.requests.filter(r => r.body?.patch?.recordingAssetId);
  assert.equal(audioPatches.length, 1, 'one complete recording association, never per-scene recordings');
  await page.locator('#manual-markers summary').click();
  const row = page.locator('[data-marker-id]').first();
  await row.getByLabel('开始（秒）', { exact: true }).fill('0.2');
  await row.getByLabel('结束（秒）', { exact: true }).fill('1.4');
  await page.locator('#add-extra-marker').click();
  await page.getByLabel('额外说了什么').fill('这里还有一句额外的话');
  await page.getByLabel('额外话开始（秒）', { exact: true }).fill('2');
  await page.getByLabel('额外话结束（秒）', { exact: true }).fill('2.6');
  await page.locator('#submit-markers').click();
  await page.waitForFunction(() => !document.getElementById('preview').disabled, { timeout: 10000 });
  const manual = state.requests.find(r => r.endpoint.endsWith('/align') && r.method === 'POST');
  assert.equal(manual.body.engine, 'segments');
  assert.equal(manual.body.segments[0].dialogueId, dialogueId);
  assert.equal(manual.body.segments[0].text, '时间之门在哪里？');
  assert.equal(manual.body.segments[1].dialogueId, undefined);
  assert.match(await page.locator('#alignment-status').innerText(), /人工.*不是自动/);
  await page.locator('#preview').click();
  await page.locator('#movie-player').waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await page.locator('#movie-player').getAttribute('src'), /^\/paper-director\/api\/projects\/project-one\/assets\/movie-/);
  assert.equal(state.requests.filter(r => r.endpoint.endsWith('/agent')).length, 0, 'direct render is not represented as agent work');
  state.health.agent.configured = true; state.health.alignment.configured = true;
  await page.locator('#refresh-health').click();
  await page.waitForFunction(() => !document.getElementById('agent-create').disabled);
  await page.locator('#agent-prompt').fill('请尊重我的故事，时间旅行加光圈。');
  await page.locator('#agent-create').click();
  await page.waitForFunction(() => document.getElementById('agent-status').textContent.includes('已交给导演助手'));
  const watchedExport = { ...state.project.exports.at(-1) };
  await page.locator('#movie-player').evaluate(player => Object.defineProperty(player, 'currentTime', { configurable: true, value: 1.25 }));
  // A new server export arrives before save redraws: feedback must still describe
  // the old export actually being watched when the author clicks send.
  state.project.exports.push({ assetId: 'movie-newer', inputRevision: state.project.revision, preview: true });
  await page.locator('#title').fill('纸偶与时间之门 · 修改中');
  await page.locator('#feedback').fill('第二张照片多停一会儿。');
  await page.locator('#send-feedback').click();
  await page.waitForFunction(() => !document.getElementById('send-feedback').disabled);
  const agentCalls = state.requests.filter(r => r.endpoint.endsWith('/agent'));
  assert.equal(agentCalls.length, 2); assert.match(agentCalls[1].body.prompt, /^第二张照片多停一会儿。\n\n当前观看电影：assetId=movie-/);
  assert.ok(agentCalls[1].body.prompt.includes(`assetId=${watchedExport.assetId}；inputRevision=${watchedExport.inputRevision}`));
  assert.doesNotMatch(agentCalls[1].body.prompt, /assetId=movie-newer/);
  assert.match(agentCalls[1].body.prompt, /currentTime=1.25 秒/);
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: path.join(OUT, 'studio-desktop.png'), fullPage: true });
  await page.screenshot({ path: path.join(OUT, 'studio-desktop-top.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(OUT, 'studio-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile page has no horizontal overflow');
  assert.deepEqual(state.errors, []);
  await context.close();
});

test('truthful errors, conflict protection, job cancellation, restore and text-only rendering', async () => {
  const { page, context, state } = await setup(browser);
  await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
  await page.locator('#title').fill('<img src=x onerror="window.pwned=1">');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('#project-title img').count(), 0);
  assert.match(await page.locator('#project-title').innerText(), /<img/);
  state.conflict = true;
  await page.locator('#title').fill('我的旧版本不能覆盖别人'); await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('这次没有覆盖'));
  assert.equal(await page.locator('#title').inputValue(), '我的旧版本不能覆盖别人');
  assert.equal(state.project.title, '另一处保存的新版本');
  assert.match(await page.locator('#save-state').innerText(), /还没保存/);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  assert.equal(state.project.title, '我的旧版本不能覆盖别人');
  state.health.agent.configured = true; state.agentError = true;
  await page.locator('#refresh-health').click(); await page.waitForFunction(() => !document.getElementById('agent-create').disabled);
  await page.locator('#agent-create').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('导演助手还没有接好'));
  assert.doesNotMatch(await page.locator('body').innerText(), /C:\/secret|key path/);
  state.project.recordingAssetId = 'recording'; state.project.assets.push({ id: 'recording', kind: 'audio', mime: 'audio/wav', metadata: { duration: 4 } });
  state.project.scenes.push({ id: 'scene-one', imageAssetId: null, action: '', dialogue: [{ id: 'line-one', characterId: 'hero', text: '你好', mode: 'normal' }], transition: 'cut', timeLabel: '' });
  state.project.alignment = { duration: 4, method: 'provided_segments', utterances: [{ dialogueId: 'line-one', start: null, end: null, matchStatus: 'unmatched', recognizedText: '' }], unmatchedSpeech: [], warnings: [] };
  await page.locator('.project-card').click();
  assert.equal(await page.locator('#preview').isDisabled(), true, 'unmatched null dialogue blocks render');
  state.health.alignment.configured = true; state.keepRunning = true;
  await page.locator('#refresh-health').click(); await page.waitForFunction(() => !document.getElementById('auto-align').disabled);
  await page.locator('#auto-align').click();
  await page.getByRole('button', { name: '取消任务' }).click();
  await page.waitForFunction(() => document.getElementById('jobs').textContent.includes('已取消'));
  const auto = state.requests.find(r => r.endpoint.endsWith('/align') && r.method === 'POST');
  assert.equal(Object.hasOwn(auto.body, 'engine'), false, 'host chooses configured auto engine');
  await page.locator('.history summary').click(); await page.locator('#load-history').click();
  await page.getByRole('button', { name: '恢复为新版本' }).click();
  await page.waitForFunction(() => document.getElementById('title').value === '恢复的第一部故事');
  assert.ok(state.requests.some(r => r.endpoint.endsWith('/restore') && Number.isInteger(r.body.expectedRevision)));
  const allFetchRequests = state.requests.filter(r => !r.endpoint.includes('/assets/'));
  assert.ok(allFetchRequests.length > 5);
  assert.deepEqual(state.errors, []);
  await context.close();
});

test('real MediaRecorder captures one synthetic stream and retains it when upload fails', async () => {
  const { page, context, state } = await setup(browser, true);
  await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
  await page.locator('#start-recording').click();
  await page.locator('#stop-recording').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.syntheticAudioContext?.currentTime > .4);
  state.review.agent = { liveStatus: 'running', lastTurnReason: null, messages: [{ text: '录音时也能看到助手消息。' }] };
  state.project.revision++;
  await page.getByText('录音时也能看到助手消息。', { exact: true }).waitFor();
  assert.equal(await page.locator('#stop-recording').isVisible(), true, 'review does not stop active microphone capture');
  assert.match(await page.locator('#recording-status').innerText(), /正在录一整段/);
  state.project.revision--; // Controlled mock status update; no real concurrent author mutation.
  state.uploadFailure = true;
  await page.locator('#stop-recording').click();
  await page.waitForFunction(() => !document.getElementById('retry-recording').hidden && !document.getElementById('retry-recording').disabled);
  assert.match(await page.locator('#recording-player').getAttribute('src'), /^blob:/);
  assert.match(await page.locator('#recording-info').innerText(), /尚未成功保存/);
  assert.equal(state.project.recordingAssetId, null);
  const pendingSrc = await page.locator('#recording-player').getAttribute('src');
  state.review.agent.messages = [{ text: '录音上传失败后仍保留在页面。' }];
  state.project.revision++;
  await page.getByText('录音上传失败后仍保留在页面。', { exact: true }).waitFor();
  assert.equal(await page.locator('#recording-player').getAttribute('src'), pendingSrc, 'review never replaces pending recording blob');
  assert.equal(await page.locator('#retry-recording').isVisible(), true);
  state.project.revision--;
  await page.locator('#retry-recording').click();
  await page.waitForFunction(() => document.getElementById('retry-recording').hidden && !document.getElementById('audio-file').disabled);
  assert.ok(state.project.recordingAssetId);
  const uploads = state.requests.filter(r => r.method === 'POST' && r.endpoint.endsWith('/assets'));
  assert.equal(uploads.length, 2, 'retry reuses same recording rather than recording each scene again');
  assert.ok(uploads[0].bytes > 100); assert.equal(uploads[0].bytes, uploads[1].bytes);
  assert.match(uploads[1].headers['content-type'], /^audio\//);
  assert.equal(state.requests.filter(r => r.body?.patch?.recordingAssetId).length, 1);
  await page.evaluate(() => {
    const player = document.getElementById('recording-player');
    window.otherPlayerPaused = 0;
    player.pause = () => { window.otherPlayerPaused++; };
    document.getElementById('movie-player').dispatchEvent(new Event('play', { bubbles: false }));
  });
  assert.equal(await page.evaluate(() => window.otherPlayerPaused), 1, 'another media play pauses the existing audio player');
  assert.deepEqual(state.errors, []);
  await context.close();
});

test('mock review: bounded text replies, truthful idle/running/cold, approval refusal/apply/dismiss and stale dirty preservation', async () => {
  const { page, context, state } = await setup(browser);
  await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
  state.project.recordingAssetId = 'recording'; state.project.assets.push({ id: 'recording', kind: 'audio', mime: 'audio/wav', metadata: { duration: 4 } });
  state.project.scenes.push({ id: 'scene-one', imageAssetId: null, action: '', dialogue: [{ id: 'line-one', characterId: 'hero', text: '你好', mode: 'normal' }], transition: 'cut', timeLabel: '' });
  await page.locator('.project-card').click();
  const proposal = id => ({ id, baseRevision: state.project.revision, currentSeconds: 2, targetSeconds: .5, sourceRange: { start: .5, end: 1.2 }, warnings: ['可能包含额外的话，请先听原段。'], requiresConfirmation: true });
  state.review.agent = { liveStatus: 'running', lastTurnReason: null, messages: [{ id: 'reply-1', text: '我找到了停顿，请听听再决定。' }] };
  state.review.proposals = [proposal('proposal-first')];
  await page.getByText('我找到了停顿，请听听再决定。', { exact: true }).waitFor();
  assert.match(await page.locator('#agent-status').innerText(), /正在整理你的电影/);
  assert.equal(await page.locator('#agent-status').getAttribute('data-live-status'), 'running');
  assert.doesNotMatch(await page.locator('#agent-status').innerText(), /lastTurnReason|liveStatus|running/);
  assert.match(await page.locator('#review-cards').innerText(), /原停顿：2.00 秒 → 新停顿：0.50 秒/);
  assert.match(await page.locator('#review-cards').innerText(), /可能包含额外的话/);
  state.review.agent.liveStatus = 'idle'; state.review.agent.lastTurnReason = 'completed';
  await page.waitForFunction(() => document.getElementById('agent-status').dataset.liveStatus === 'idle');
  assert.match(await page.locator('#agent-status').innerText(), /这一轮已停下.*这一轮回复已结束/);
  assert.doesNotMatch(await page.locator('#agent-status').innerText(), /lastTurnReason|liveStatus|idle|completed/);
  assert.equal(await page.locator('#movie-player').isVisible(), false, 'idle is not a movie export');
  assert.match(await page.locator('#jobs').innerText(), /没有制作工具任务/);
  // Refusing the explicit browser confirmation MUST send no approval request.
  state.rejectConfirm = true;
  await page.getByRole('button', { name: '确认剪短', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-review-action="apply"]').disabled);
  assert.equal(state.requests.filter(r => r.endpoint.includes('/reviews/')).length, 0);
  state.rejectConfirm = false;
  await page.getByRole('button', { name: '确认剪短', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal-id]').length === 0);
  assert.deepEqual(state.requests.find(r => r.endpoint.includes('/reviews/')).body, { expectedRevision: 1, decision: 'apply' });
  assert.equal(state.project.revision, 2); assert.equal(state.project.recordingAssetId, 'recording');
  state.review.proposals = [proposal('proposal-dismiss')];
  await page.getByRole('button', { name: '保留原样', exact: true }).waitFor();
  await page.getByRole('button', { name: '保留原样', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal-id]').length === 0);
  assert.equal(state.requests.filter(r => r.endpoint.includes('/reviews/')).at(-1).body.decision, 'dismiss');
  assert.equal(state.project.revision, 2, 'dismiss does not change movie content');
  state.review.proposals = [proposal('proposal-stale')];
  await page.getByRole('button', { name: '确认剪短', exact: true }).waitFor();
  await page.locator('#title').fill('我还没保存的标题');
  await page.locator('#story').fill('我还没保存的故事');
  await page.locator('#agent-prompt').fill('未发送的助手输入');
  await page.locator('#feedback').fill('未发送的观看反馈');
  await page.locator('#manual-markers summary').click();
  await page.getByLabel('开始（秒）', { exact: true }).fill('0.31');
  state.reviewConflict = true;
  await page.getByRole('button', { name: '确认剪短', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('确认卡已过期'));
  assert.equal(await page.locator('#title').inputValue(), '我还没保存的标题');
  assert.equal(await page.locator('#story').inputValue(), '我还没保存的故事');
  assert.equal(await page.locator('#agent-prompt').inputValue(), '未发送的助手输入');
  assert.equal(await page.locator('#feedback').inputValue(), '未发送的观看反馈');
  assert.equal(await page.getByLabel('开始（秒）', { exact: true }).inputValue(), '0.31');
  assert.match(await page.locator('#save-state').innerText(), /还没保存/);
  assert.equal(state.requests.filter(r => r.method === 'PATCH').length, 0, 'review must not auto-save author drafts');
  // Oversized/untrusted reply fixture tests the UI guard independently of Core's guard.
  state.review.agent = { liveStatus: 'cold', lastTurnReason: 'error', messages: Array.from({ length: 20 }, (_, i) => ({ text: i === 19 ? '<img src=x onerror="window.pwned=1">' : i === 18 ? 'C:/secret/private.txt' : '长'.repeat(10000), interrupted: i === 19 })) };
  await page.waitForFunction(() => document.getElementById('agent-status').dataset.liveStatus === 'cold');
  assert.match(await page.locator('#agent-status').innerText(), /暂时没有运行.*这一轮没能完成/);
  assert.doesNotMatch(await page.locator('#agent-status').innerText(), /lastTurnReason|liveStatus|cold|error/);
  const text = await page.locator('#agent-messages').innerText();
  assert.ok(text.length < 8500); assert.doesNotMatch(text, /C:\/secret/);
  assert.equal(await page.locator('#agent-messages img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('#title').inputValue(), '我还没保存的标题');
  state.review.agent.messages = [{ text: '<img src=x onerror="window.pwned=1">', interrupted: true }];
  await page.waitForFunction(() => document.getElementById('agent-messages').textContent.includes('<img'));
  assert.match(await page.locator('#agent-messages').innerText(), /被中断/);
  assert.equal(await page.locator('#agent-messages img').count(), 0);
  state.review.agent.messages = [];
  state.jobs = [{ id: 'failed-job', kind: 'render', revision: 2, status: 'failed', error: { code: 'WORKER_NOT_READY' } }];
  await page.waitForFunction(() => document.getElementById('jobs').textContent.includes('没有完成'));
  assert.match(await page.locator('#agent-messages').innerText(), /没有可见的助手回复/);
  assert.deepEqual(state.errors, []);
  await context.close();
});

test('mock review original-range playback seeks original recording, stops bounded and cancels after other playback', async () => {
  const { page, context, state } = await setup(browser);
  await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
  state.project.recordingAssetId = 'recording'; state.project.assets.push({ id: 'recording', kind: 'audio', mime: 'audio/wav', metadata: { duration: 4 } });
  await page.locator('.project-card').click();
  state.review.proposals = [{ id: 'listen-proposal', currentSeconds: .7, targetSeconds: .25, sourceRange: { start: .5, end: 1.2 }, warnings: [] }];
  await page.getByRole('button', { name: '试听原段', exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('recording-player').readyState >= 1);
  await page.getByRole('button', { name: '试听原段', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('recording-player').currentTime >= .5);
  const position = await page.locator('#recording-player').evaluate(player => player.currentTime);
  assert.ok(position < 1.4, `seek was into sourceRange: ${position}`);
  assert.equal(await page.locator('#recording-player').getAttribute('src'), '/paper-director/api/projects/project-one/assets/recording');
  await page.waitForFunction(() => { const p = document.getElementById('recording-player'); return p.paused && p.currentTime >= 1.2; });
  assert.ok(await page.locator('#recording-player').evaluate(player => player.currentTime < 1.5), 'timer stops near range end, not end of complete recording');
  assert.equal(state.requests.filter(r => r.endpoint.includes('/reviews/')).length, 0, 'listening never applies a cut');
  await page.getByRole('button', { name: '试听原段', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('recording-player').paused);
  await page.locator('#movie-player').evaluate(player => player.dispatchEvent(new Event('play')));
  await page.waitForFunction(() => document.getElementById('recording-player').paused);
  // Once another player interrupts the snippet, manual whole-recording playback
  // is not constrained by the old snippet's timer or timeupdate listener.
  await page.locator('#recording-player').evaluate(async player => { player.currentTime = 2; await player.play(); });
  await page.waitForFunction(() => document.getElementById('recording-player').currentTime > 2.3);
  assert.equal(await page.locator('#recording-player').evaluate(player => player.paused), false);
  await page.locator('#recording-player').evaluate(player => player.pause());
  assert.deepEqual(state.errors, []);
  await context.close();
});

test('mock conflict: dirty → review apply success → save 409 → cancel → explicit dirty-only retry', async () => {
  const { page, context, state } = await setup(browser);
  try {
    await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
    state.project.revision = 7;
    state.project.recordingAssetId = 'recording';
    state.project.assets.push({ id: 'recording', kind: 'audio', mime: 'audio/wav', metadata: { duration: 4 } });
    state.project.scenes.push({ id: 'scene-one', imageAssetId: null, action: '', dialogue: [{ id: 'line-one', characterId: 'hero', text: '你好', mode: 'normal' }], transition: 'cut', timeLabel: '' });
    await page.locator('.project-card').click();
    await page.waitForFunction(() => document.getElementById('revision').textContent.includes('第 7 版'));
    state.review.proposals = [{ id: 'apply-dirty', currentSeconds: 2, targetSeconds: .5, sourceRange: { start: .5, end: 1.2 }, warnings: [] }];
    await page.getByRole('button', { name: '确认剪短', exact: true }).waitFor();
    await page.locator('#title').fill('作者留在第七版的标题');
    await page.locator('#agent-prompt').fill('不要丢掉助手输入');
    await page.locator('#feedback').fill('不要丢掉观影反馈');
    await page.locator('#manual-markers summary').click();
    await page.getByLabel('开始（秒）', { exact: true }).fill('0.31');
    await page.getByLabel('结束（秒）', { exact: true }).fill('1.2');
    await page.locator('#add-extra-marker').click();
    await page.getByLabel('额外说了什么').fill('额外的一句话');
    const originalSrc = await page.locator('#recording-player').getAttribute('src');
    await page.getByRole('button', { name: '确认剪短', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-proposal-id]').length === 0);
    assert.equal(state.project.revision, 8);
    assert.match(await page.locator('#revision').innerText(), /第 7 版/);
    // Server-only fields must survive the later retry; no implicit merge happens now.
    state.project.story = '服务器的新故事'; state.project.edits.push({ id: 'approved-cut' });
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('这次没有覆盖'));
    const patches = () => state.requests.filter(r => r.method === 'PATCH');
    assert.equal(patches().length, 1); assert.equal(patches()[0].body.expectedRevision, 7);
    assert.equal(state.dialogs.length, 1, '409 does not automatically ask to retry or write again');
    assert.equal(await page.locator('#title').inputValue(), '作者留在第七版的标题');
    assert.equal(await page.locator('#story').inputValue(), '', 'conflict snapshot is not silently merged into the draft');
    assert.equal(await page.getByLabel('开始（秒）', { exact: true }).inputValue(), '0.31');
    assert.equal(await page.getByLabel('额外说了什么').inputValue(), '额外的一句话');
    assert.equal(await page.locator('#recording-player').getAttribute('src'), originalSrc);
    state.rejectConfirm = true;
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('已取消保存'));
    assert.equal(patches().length, 1); assert.match(await page.locator('#save-state').innerText(), /还没保存/);
    assert.match(await page.locator('#revision').innerText(), /第 7 版/);
    assert.equal(await page.locator('#agent-prompt').inputValue(), '不要丢掉助手输入');
    assert.equal(await page.locator('#feedback').inputValue(), '不要丢掉观影反馈');
    state.rejectConfirm = false;
    // Even a non-standard 409 on a confirmed retry must retain everything again.
    state.conflict = true; state.conflictCode = 'OTHER_CONFLICT';
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('这次没有覆盖'));
    assert.equal(patches().length, 2); assert.equal(state.project.revision, 9);
    assert.equal(await page.locator('#title').inputValue(), '作者留在第七版的标题');
    assert.equal(await page.getByLabel('开始（秒）', { exact: true }).inputValue(), '0.31');
    assert.equal(await page.locator('#recording-player').getAttribute('src'), originalSrc);
    state.project.credits.director = '服务器上的导演'; state.project.revision = 10;
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
    assert.deepEqual(patches().at(-1).body, { expectedRevision: 10, patch: { title: '作者留在第七版的标题' } });
    assert.equal(state.project.revision, 11); assert.equal(state.project.story, '服务器的新故事');
    assert.equal(state.project.credits.director, '服务器上的导演');
    assert.deepEqual(state.project.edits, [{ id: 'approved-cut' }]);
    assert.equal(await page.getByLabel('开始（秒）', { exact: true }).inputValue(), '0.31');
    assert.equal(await page.getByLabel('额外说了什么').inputValue(), '额外的一句话');
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('mock conflict: marker-only draft keeps old recording until explicit marker disposal', async () => {
  const { page, context, state } = await setup(browser);
  try {
    await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
    state.project.recordingAssetId = 'recording';
    state.project.assets.push({ id: 'recording', kind: 'audio', mime: 'audio/wav', metadata: { duration: 4 } });
    state.project.scenes.push({ id: 'scene-one', imageAssetId: null, action: '', dialogue: [{ id: 'line-one', characterId: 'hero', text: '你好', mode: 'normal' }], transition: 'cut', timeLabel: '' });
    await page.locator('.project-card').click();
    state.review.proposals = [{ id: 'stale-markers', currentSeconds: 2, targetSeconds: .5, sourceRange: { start: .5, end: 1.2 }, warnings: [] }];
    await page.getByRole('button', { name: '确认剪短', exact: true }).waitFor();
    await page.locator('#manual-markers summary').click();
    await page.getByLabel('开始（秒）', { exact: true }).fill('0.42');
    const originalSrc = await page.locator('#recording-player').getAttribute('src');
    state.project.assets.push({ id: 'recording-new', kind: 'audio', mime: 'audio/wav', metadata: { duration: 4 } });
    state.project.recordingAssetId = 'recording-new'; state.reviewConflict = true;
    await page.getByRole('button', { name: '确认剪短', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('确认卡已过期'));
    assert.equal(await page.locator('#recording-player').getAttribute('src'), originalSrc);
    assert.equal(await page.getByLabel('开始（秒）', { exact: true }).inputValue(), '0.42');
    assert.equal(await page.locator('#save').isDisabled(), false, 'marker-only conflict has an explicit recovery action');
    // Polls may refresh cards but must not replace these old recording inputs.
    state.review.agent.messages = [{ text: '冲突后继续保留旧标记' }];
    await page.getByText('冲突后继续保留旧标记', { exact: true }).waitFor();
    assert.equal(await page.locator('#recording-player').getAttribute('src'), originalSrc);
    state.confirmAnswers = [true, false];
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('旧时间标记和旧录音已保留'));
    assert.equal(await page.getByLabel('开始（秒）', { exact: true }).inputValue(), '0.42');
    assert.equal(await page.locator('#recording-player').getAttribute('src'), originalSrc);
    assert.equal(state.requests.filter(r => r.method === 'PATCH').length, 0);
    await page.locator('#title').fill('保留的草稿标题');
    state.confirmAnswers = [true, true];
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
    assert.equal(state.project.title, '保留的草稿标题');
    assert.equal(await page.locator('#recording-player').getAttribute('src'), '/paper-director/api/projects/project-one/assets/recording-new');
    assert.equal(await page.getByLabel('开始（秒）', { exact: true }).inputValue(), '');
    assert.match(state.dialogs.at(-1), /明确放下旧时间标记/);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('mock conflict: recorded blob survives association 409 and cancelled retry without another upload', async () => {
  const { page, context, state } = await setup(browser, true);
  try {
    await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
    await page.locator('#start-recording').click();
    await page.locator('#stop-recording').waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.syntheticAudioContext?.currentTime > .4);
    state.conflict = true;
    await page.locator('#stop-recording').click();
    await page.waitForFunction(() => !document.getElementById('retry-recording').hidden && !document.getElementById('retry-recording').disabled && document.getElementById('notice').textContent.includes('这次没有覆盖'));
    const src = await page.locator('#recording-player').getAttribute('src');
    assert.match(src, /^blob:/); assert.equal(state.project.recordingAssetId, null);
    assert.match(await page.locator('#save-state').innerText(), /还没保存/);
    const uploads = () => state.requests.filter(r => r.endpoint.endsWith('/assets') && r.method === 'POST');
    assert.equal(uploads().length, 1);
    state.rejectConfirm = true;
    await page.locator('#retry-recording').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('已取消保存'));
    assert.equal(await page.locator('#recording-player').getAttribute('src'), src);
    assert.equal(uploads().length, 1); assert.equal(state.project.recordingAssetId, null);
    state.rejectConfirm = false;
    const revision = state.project.revision;
    await page.locator('#retry-recording').click();
    await page.waitForFunction(() => document.getElementById('retry-recording').hidden && !document.getElementById('audio-file').disabled);
    assert.equal(uploads().length, 1, 'retry associates the already uploaded immutable recording, not a second copy');
    assert.deepEqual(state.requests.filter(r => r.method === 'PATCH').at(-1).body, { expectedRevision: revision, patch: { recordingAssetId: 'asset-1' } });
    assert.equal(state.project.recordingAssetId, 'asset-1');
    assert.equal(state.project.title, '另一处保存的新版本');
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('mock conflict: selected synthetic audio is retained when the upload itself returns 409', async () => {
  const { page, context, state } = await setup(browser);
  try {
    await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
    // Keep the local base stale through the input event without any production server.
    await page.route('**/api/projects/project-one/assets', async route => {
      state.project.revision++;
      await page.unroute('**/api/projects/project-one/assets');
      await route.fallback();
    });
    await page.locator('#audio-file').setInputFiles({ name: 'synthetic-conflict.wav', mimeType: 'audio/wav', buffer: wav() });
    await page.waitForFunction(() => !document.getElementById('retry-recording').hidden && !document.getElementById('retry-recording').disabled && document.getElementById('notice').textContent.includes('这次没有覆盖'));
    const src = await page.locator('#recording-player').getAttribute('src');
    assert.match(src, /^blob:/); assert.equal(state.project.recordingAssetId, null);
    state.rejectConfirm = true;
    await page.locator('#retry-recording').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('已取消保存'));
    assert.equal(await page.locator('#recording-player').getAttribute('src'), src);
    assert.equal(state.requests.filter(r => r.endpoint.endsWith('/assets') && r.method === 'POST').length, 1);
    state.rejectConfirm = false;
    await page.locator('#retry-recording').click();
    await page.waitForFunction(() => document.getElementById('retry-recording').hidden && !document.getElementById('audio-file').disabled);
    const uploads = state.requests.filter(r => r.endpoint.endsWith('/assets') && r.method === 'POST');
    assert.equal(uploads.length, 2); assert.equal(uploads[0].bytes, uploads[1].bytes);
    assert.equal(state.project.recordingAssetId, 'asset-1');
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test.after(async () => { await browser.close(); });
