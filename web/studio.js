// Child-facing studio. Fixed same-origin APIs; no executable/project-supplied HTML.
const BASE = '/paper-director/api';
const $ = id => document.getElementById(id);
const ACTIVE = new Set(['queued', 'running']);
const state = { project: null, draft: null, projects: [], dirty: new Set(), busy: false, health: null,
  jobs: [], timer: null, generation: 0, markers: new Map(), extras: [], recorder: null, stream: null,
  recordTimer: null, recordingStarted: 0, objectUrl: null, pendingRecording: null, pendingRecordingAssetId: null, seenJobs: new Set(),
  review: null, reviewRequest: 0, markerDirty: false, snippet: null, snippetTimer: null, watched: null,
  conflictPending: false, conflictBaseline: null };
const clone = value => structuredClone(value);
const uid = () => crypto.randomUUID();
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function assetUrl(projectId, assetId) {
  if (!safeId(projectId) || !safeId(assetId)) throw new Error('INVALID_ASSET');
  return `${BASE}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`;
}
function node(tag, text, attributes = {}) {
  const value = document.createElement(tag);
  if (text !== undefined && text !== null) value.textContent = text;
  for (const [key, item] of Object.entries(attributes)) {
    if (key === 'class') value.className = item;
    else if (key === 'value') value.value = item;
    else if (key === 'hidden' || key === 'disabled') value[key] = item;
    else value.setAttribute(key, item);
  }
  return value;
}
function button(text, action, className = 'quiet', label) {
  const value = node('button', text, { type: 'button', class: className });
  if (label) value.setAttribute('aria-label', label);
  value.addEventListener('click', action);
  return value;
}
function input(labelText, value, update, attributes = {}, tag = 'input') {
  const label = node('label', labelText);
  const field = node(tag, null, { ...attributes, value: value ?? '' });
  field.addEventListener('input', () => update(field.value));
  label.append(field);
  return label;
}
function select(labelText, value, options, update) {
  const label = node('label', labelText);
  const field = node('select');
  for (const [key, text] of options) field.append(node('option', text, { value: key }));
  field.value = value;
  field.addEventListener('change', () => update(field.value));
  label.append(field);
  return label;
}
function notice(message, tone = '') {
  $('notice').textContent = message;
  $('notice').className = `notice ${tone}`;
  $('notice').hidden = false;
}
const ERRORS = {
  REVISION_CONFLICT: '故事本有了新版本。这次没有覆盖任何内容，你未保存的想法、时间标记和录音仍在原处。请点“保存”或录音的“重试保存”，确认后才会保存到新版本；取消会继续保留输入。',
  EXPECTED_REVISION_REQUIRED: '版本信息过期了，请刷新故事本后再试。',
  AGENT_NOT_CONFIGURED: '导演助手还没有接好，请请大人配置工作室。你的故事和录音都还在。',
  AGENT_UNAVAILABLE: '导演助手暂时不能开工。请请大人检查配置，不会假装电影已经制作。',
  ASR_NOT_CONFIGURED: '自动听录音还没准备好。请请大人配置本地识别，或展开下方的人工时间标记。',
  ALIGNMENT_REQUIRED: '先把录音和台词对齐，再来制作电影。',
  ALIGNMENT_INCOMPLETE: '还有台词没找到时间。请补充人工时间标记，不需要重新录每一幕。',
  UNMATCHED_DIALOGUE: '还有台词没找到时间，请补充人工时间标记。',
  MODEL_NOT_READY: '本地听录音模型还没有准备好。可以请大人帮助标记时间。',
  WORKER_NOT_READY: '电影工作室的制作工具还没有准备好，请请大人检查安装。',
  PYTHON_NOT_CONFIGURED: '电影制作工具还没有准备好，请请大人配置工作室。',
  DEPENDENCY_MISSING: '电影制作工具缺少组件，请请大人检查安装。',
  FONT_NOT_READY: '工作室还缺少合适的中文字，请请大人检查字体。',
  FONT_GLYPHS_MISSING: '有些字的字体还没有准备好，请请大人检查中文字体。',
  UNSUPPORTED_MEDIA: '这个素材格式还不支持。照片请用 PNG、JPEG 或 WebP；录音请用常见音频格式。',
  MEDIA_TYPE_MISMATCH: '文件实际格式与标记不一致，请换一个正常的图片或录音文件。',
  ASSET_TOO_LARGE: '文件太大或是空的，请请大人帮忙整理后再上传。',
  PROJECT_QUOTA: '这个故事本的素材有点多，请请大人帮忙整理。',
  JOB_RUNNING: '这部电影已经有一个任务在进行，先等它完成或取消它吧。',
  NEEDS_REVIEW: '有些台词时间还需要检查。请先听一听录音，再决定正式制作。'
};
function friendly(error) {
  const code = String(error?.code || 'REQUEST_FAILED');
  if (ERRORS[code]) return ERRORS[code];
  if (/AGENT|PRESET/.test(code)) return ERRORS.AGENT_UNAVAILABLE;
  if (/ASR|MODEL/.test(code)) return ERRORS.ASR_NOT_CONFIGURED;
  if (/ALIGNMENT|DIALOGUE/.test(code)) return ERRORS.ALIGNMENT_INCOMPLETE;
  return '这一步没有完成，请稍后再试，或请大人检查工作室。你的原素材没有被删除。';
}
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob) options.body = body;
    else { options.body = JSON.stringify(body); options.headers['Content-Type'] = 'application/json'; }
  }
  let response, envelope;
  try { response = await fetch(BASE + path, options); envelope = await response.json(); }
  catch { throw { code: 'CONNECTION_FAILED' }; }
  if (!response.ok || envelope?.ok !== true) throw { code: envelope?.error?.code || 'REQUEST_FAILED', status: response.status };
  return envelope.data;
}
const projectPath = suffix => `/projects/${encodeURIComponent(state.project.id)}${suffix || ''}`;
function publicText(value, max = 1000) {
  if (typeof value !== 'string') return '';
  if (/[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var|etc|root|private|opt|mnt)\/|(?:api[_-]?key|authorization|password|secret|token)\s*[:=]|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/i.test(value)) return '这条消息含有工作室内部信息，已隐藏。请请大人检查。'.slice(0, max);
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}
function canRefreshProject() {
  return !state.conflictPending && !state.dirty.size && !state.markerDirty && !state.busy && !state.recorder && !state.pendingRecording && !state.snippet;
}
function mark(field) {
  state.dirty.add(field);
  $('save-state').textContent = '有新的想法，还没保存';
  controls();
}
function hasMissingAlignment() {
  const p = state.project;
  if (!p?.alignment) return true;
  const utterances = new Map((p.alignment.utterances || []).map(u => [u.dialogueId, u]));
  return p.scenes.flatMap(s => s.dialogue).some(d => {
    if (!d.text.trim()) return false;
    const u = utterances.get(d.id);
    return !u || !Number.isFinite(u.start) || !Number.isFinite(u.end) || u.end <= u.start || u.matchStatus === 'unmatched';
  });
}
function controls() {
  const locked = state.busy || !!state.recorder || !!state.pendingRecording;
  for (const field of document.querySelectorAll('#editor input, #editor textarea, #editor select, #editor button, #new-project, #welcome-create, .project-card')) field.disabled = locked;
  $('stop-recording').disabled = state.busy;
  $('retry-recording').disabled = state.busy;
  for (const cancel of document.querySelectorAll('[data-cancel-job]')) cancel.disabled = state.busy;
  $('save').disabled = locked || (!state.dirty.size && !state.conflictPending);
  const hasProject = !!state.project;
  const hasAudio = !!state.project?.recordingAssetId;
  const hasScenes = !!state.project?.scenes.length;
  const inProgress = state.jobs.some(job => ACTIVE.has(job.status));
  $('auto-align').disabled = locked || !hasAudio || !hasScenes || inProgress || !state.health?.alignment?.configured;
  $('agent-create').disabled = locked || !hasProject || !state.health?.agent?.configured;
  $('send-feedback').disabled = locked || !hasProject || !state.health?.agent?.configured;
  const canRender = !locked && hasAudio && hasScenes && !hasMissingAlignment() && !inProgress && !!state.health?.render?.ready;
  $('preview').disabled = !canRender;
  $('export').disabled = !canRender;
  $('submit-markers').disabled = locked || !hasAudio || inProgress;
  $('start-recording').disabled = locked || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined';
  $('add-character').disabled = locked || (state.draft?.characters.length || 0) >= 8;
  for (const control of document.querySelectorAll('[data-review-action]')) {
    control.disabled = locked || (control.dataset.reviewAction === 'listen' && (!hasAudio || control.dataset.playable !== 'true' || state.review?.revision !== state.project?.revision));
  }
}
async function task(action) {
  if (state.busy) return;
  state.busy = true; controls();
  try { await action(); }
  catch (error) {
    if (error?.code === 'SAVE_CANCELLED') return;
    if ((error?.status === 409 || error?.code === 'REVISION_CONFLICT') && state.project) {
      await rememberConflict();
      notice(ERRORS.REVISION_CONFLICT, 'warning');
    } else notice(friendly(error), 'error');
  } finally { state.busy = false; controls(); }
}
function acceptProject(project, reset = true) {
  if (!project || !safeId(project.id)) throw { code: 'INVALID_PROJECT' };
  state.project = project;
  if (reset) {
    state.draft = clone(project); state.dirty.clear();
    state.conflictPending = false; state.conflictBaseline = null;
  }
  drawProject();
}
async function rememberConflict() {
  // A server snapshot is only a candidate for an explicit retry, never the author draft.
  state.conflictPending = true; state.conflictBaseline = null;
  try { state.conflictBaseline = await api(projectPath()); }
  catch { /* Keep the old inputs even when fetching the conflict baseline fails. */ }
}
async function saveDraft(explicitRetry = false) {
  let baseline = state.project, discardMarkers = false;
  if (state.conflictPending) {
    if (!explicitRetry) {
      notice(ERRORS.REVISION_CONFLICT, 'warning');
      throw { code: 'SAVE_CANCELLED' };
    }
    // Re-read on every explicit attempt: the previous conflict snapshot may itself be stale.
    baseline = await api(projectPath()); state.conflictBaseline = baseline;
    if (!confirm(`故事本已有第 ${baseline.revision} 版。要把你尚未保存的想法保存到这一版吗？只有你改过的部分会写入，其他内容使用新版本（可能包括录音）。点击“取消”会保留当前输入，不保存也不切换版本。`)) {
      notice('已取消保存。未保存的想法、时间标记和录音仍在原处。', 'warning');
      throw { code: 'SAVE_CANCELLED' };
    }
    const markerSourceChanged = baseline.recordingAssetId !== state.project.recordingAssetId ||
      JSON.stringify(baseline.scenes) !== JSON.stringify(state.project.scenes) ||
      JSON.stringify(baseline.characters) !== JSON.stringify(state.project.characters);
    if (state.markerDirty && markerSourceChanged) {
      if (!confirm('新版本的录音或台词已经变化，旧时间标记不能直接套用。是否明确放下旧时间标记，保存想法后切换到新版本，再重新听录音标记？点击“取消”会保留旧输入和旧录音，不做任何保存。')) {
        notice('旧时间标记和旧录音已保留。请先核对并记下这些标记；确认放下旧标记后才能切换新版本。', 'warning');
        throw { code: 'SAVE_CANCELLED' };
      }
      discardMarkers = true;
    }
  }
  if (!state.dirty.size && !state.conflictPending) return;
  const patch = {};
  for (const field of state.dirty) patch[field] = clone(state.draft[field]);
  const updated = state.dirty.size ? await api(projectPath(), { method: 'PATCH', body: { expectedRevision: baseline.revision, patch } }) : baseline;
  // Do not discard markers until the write succeeds (another 409 may still occur).
  if (discardMarkers) { state.markerDirty = false; state.markers.clear(); state.extras = []; }
  acceptProject(updated);
  await listProjects();
}
async function listProjects() {
  state.projects = await api('/projects');
  const list = $('projects'); list.replaceChildren();
  if (!state.projects.length) list.append(node('p', '第一本故事，等你打开。', { class: 'muted' }));
  for (const project of state.projects) {
    const item = button('', () => task(() => openProject(project.id)), `project-card ${project.id === state.project?.id ? 'active' : ''}`);
    item.append(node('strong', project.title), node('small', `故事本 · 第 ${project.revision} 版`));
    if (project.id === state.project?.id) item.setAttribute('aria-current', 'true');
    list.append(item);
  }
  controls();
}
function stopPolling() {
  clearTimeout(state.timer); state.timer = null; state.generation += 1; state.reviewRequest += 1;
  stopSnippet(); state.review = null; state.markerDirty = false; state.watched = null;
  $('agent-messages').replaceChildren(); $('review-cards').replaceChildren();
}
async function openProject(id) {
  if (state.recorder || state.pendingRecording) { notice('先结束并保存这段录音，再换故事本。刚才的录音还留在这个页面。', 'warning'); return; }
  if (state.dirty.size || state.markerDirty) {
    if (confirm('还有没保存的想法或时间标记。先留在这里保存吗？点击“取消”才会放下这些修改并打开故事本。')) return;
    state.dirty.clear();
  }
  stopPolling();
  document.querySelectorAll('audio,video').forEach(media => media.pause());
  state.markers.clear(); state.extras = []; state.jobs = []; state.seenJobs.clear();
  $('history-list').replaceChildren(); $('agent-status').textContent = '';
  $('agent-prompt').value = ''; $('feedback').value = '';
  acceptProject(await api(`/projects/${encodeURIComponent(id)}`));
  await listProjects();
  await pollJobs(state.generation);
}
async function createProject() {
  if (state.pendingRecording) { notice('先保存刚才录好的完整声音，再开始新故事。', 'warning'); return; }
  if (state.dirty.size) await saveDraft();
  const project = await api('/projects', { method: 'POST', body: { title: '我的纸上故事' } });
  stopPolling(); state.markers.clear(); state.extras = []; state.jobs = []; state.seenJobs.clear();
  $('agent-prompt').value = ''; $('feedback').value = ''; $('agent-status').textContent = ''; $('history-list').replaceChildren();
  acceptProject(project); await listProjects(); await pollJobs(state.generation);
  $('title').focus();
}
function drawProject() {
  const p = state.draft;
  $('welcome').hidden = !!p; $('editor').hidden = !p;
  if (!p) return;
  $('project-title').textContent = p.title;
  $('revision').textContent = `第 ${state.project.revision} 版 · 每次保存都是一个新版本`;
  $('save-state').textContent = state.dirty.size ? '有新的想法，还没保存' : '已保存';
  for (const key of ['title', 'story']) $(key).value = p[key];
  for (const key of ['director', 'voice']) $(key).value = p.credits[key];
  drawCharacters(); drawScenes(); drawRecording(); drawMarkers(); drawAlignment(); drawMovie(); drawJobs(); controls();
}
function drawCharacters() {
  const holder = $('characters'); holder.replaceChildren();
  for (const character of state.draft.characters) {
    const card = node('div', null, { class: 'character' });
    const color = input(`${character.name}的颜色`, character.color, value => { character.color = value; mark('characters'); }, { type: 'color', 'aria-label': `${character.name}的颜色` });
    color.firstChild && (color.className = 'character-color');
    const name = input('角色名字', character.name, value => { character.name = value; mark('characters'); }, { maxlength: '40' });
    name.className = 'character-name';
    name.querySelector('input').addEventListener('change', () => { drawScenes(); drawMarkers(); });
    const remove = button('×', () => {
      const used = state.draft.scenes.some(s => s.dialogue.some(d => d.characterId === character.id));
      if (used) { notice('这个角色还有台词。先把台词交给其他角色，再移除它。', 'warning'); return; }
      state.draft.characters = state.draft.characters.filter(c => c.id !== character.id); mark('characters'); drawCharacters(); drawScenes();
    }, 'quiet icon-button', `移除角色${character.name}`);
    card.append(color, name, remove); holder.append(card);
  }
}
function sceneChanged(redraw = false) { mark('scenes'); if (redraw) { drawScenes(); drawMarkers(); controls(); } }
function drawScenes() {
  const holder = $('scenes'); holder.replaceChildren();
  if (!state.draft.scenes.length) holder.append(node('p', '放进第一张照片，让故事开始吧。', { class: 'empty-note' }));
  state.draft.scenes.forEach((scene, index) => {
    const card = node('article', null, { class: 'scene', 'data-scene-id': scene.id, 'aria-label': `第${index + 1}幕` });
    const layout = node('div', null, { class: 'scene-layout' });
    const photo = node('div', null, { class: 'scene-photo' });
    if (scene.imageAssetId) photo.append(node('img', null, { src: assetUrl(state.project.id, scene.imageAssetId), alt: `故事第 ${index + 1} 张照片`, loading: 'lazy' }));
    else photo.append(node('p', '这幕还没有照片', { class: 'empty-note' }));
    photo.append(node('p', `第 ${index + 1} 幕`));
    const actions = node('div', null, { class: 'scene-actions' });
    for (const [direction, title, label] of [[-1, '↑', '向前移'], [1, '↓', '向后移']]) {
      const move = button(title, () => {
        const target = index + direction;
        if (target < 0 || target >= state.draft.scenes.length) return;
        [state.draft.scenes[index], state.draft.scenes[target]] = [state.draft.scenes[target], state.draft.scenes[index]];
        sceneChanged(true);
      }, 'quiet', `第${index + 1}幕${label}`);
      move.disabled = index + direction < 0 || index + direction >= state.draft.scenes.length;
      actions.append(move);
    }
    actions.append(button('移除', () => {
      if (!confirm(`把第 ${index + 1} 幕从故事中移除？原照片仍会保留。`)) return;
      state.draft.scenes = state.draft.scenes.filter(s => s.id !== scene.id); sceneChanged(true);
    }, 'danger', `移除第${index + 1}幕`));
    photo.append(actions);
    const body = node('div', null, { class: 'scene-body' });
    body.append(input('这里发生了什么动作？', scene.action, value => { scene.action = value; sceneChanged(); }, { rows: '2', maxlength: '4000', placeholder: '例如：纸偶踮起脚尖，悄悄打开时钟的小门。' }, 'textarea'));
    const lines = node('div', null, { class: 'dialogues' });
    for (const dialogue of scene.dialogue) {
      const line = node('div', null, { class: 'dialogue', 'data-dialogue-id': dialogue.id });
      const cast = state.draft.characters.map(c => [c.id, c.name]); cast.push(['both', '两位一起'], ['narrator', '旁白']);
      line.append(select('谁在说', dialogue.characterId, cast, value => { dialogue.characterId = value; sceneChanged(); }),
        input('这句台词', dialogue.text, value => { dialogue.text = value; sceneChanged(); }, { rows: '2', maxlength: '1000', placeholder: '写下角色想说的话…' }, 'textarea'),
        select('怎么说', dialogue.mode, [['normal', '正常说'], ['thought', '心里想'], ['small', '小声说'], ['burst', '大声喊']], value => { dialogue.mode = value; sceneChanged(); }),
        button('×', () => { scene.dialogue = scene.dialogue.filter(d => d.id !== dialogue.id); sceneChanged(true); }, 'quiet delete-line', '移除这句台词'));
      lines.append(line);
    }
    body.append(lines, button('＋ 加一句台词', () => {
      if (scene.dialogue.length >= 30) { notice('这一幕的台词已经很多啦，可以分成另一张照片。', 'warning'); return; }
      scene.dialogue.push({ id: uid(), characterId: state.draft.characters[0]?.id || 'narrator', text: '', mode: 'normal' }); sceneChanged(true);
    }, 'quiet'));
    const transition = node('div', null, { class: 'transition-fields' });
    transition.append(select('这一幕怎样登场', scene.transition, [['cut', '普通切换'], ['magic', '魔法光圈'], ['time', '时间文字卡']], value => { scene.transition = value; sceneChanged(true); }));
    if (scene.transition === 'time') transition.append(input('时间卡写什么', scene.timeLabel, value => { scene.timeLabel = value; sceneChanged(); }, { maxlength: '120', placeholder: '例如：一百年以后' }));
    body.append(transition); layout.append(photo, body); card.append(layout); holder.append(card);
  });
}
async function uploadAsset(file, kind) {
  const mime = file.type.split(';')[0] || ({ wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[file.name?.split('.').pop().toLowerCase()]);
  if (!mime || file.size === 0) throw { code: 'UNSUPPORTED_MEDIA' };
  const result = await api(projectPath('/assets'), { method: 'POST', body: file,
    headers: { 'Content-Type': mime === 'audio/x-wav' ? 'audio/wav' : mime, 'X-File-Name': encodeURIComponent(file.name || '完整录音.webm'), 'X-Asset-Kind': kind, 'X-Project-Revision': String(state.project.revision) } });
  acceptProject(result.project);
  return result.asset;
}
async function uploadPhotos(files) {
  await saveDraft();
  for (const file of files) {
    if (state.project.scenes.length >= 100) throw { code: 'PROJECT_QUOTA' };
    const asset = await uploadAsset(file, 'image');
    state.draft.scenes.push({ id: uid(), imageAssetId: asset.id, action: '', dialogue: [], transition: 'cut', timeLabel: '' });
    mark('scenes'); await saveDraft();
  }
  notice('照片放进故事本了。可以调整顺序，再写动作和台词。');
}
async function uploadRecording(file, explicitRetry = false) {
  // File uploads need the same in-page recovery as a freshly captured recording.
  if (!state.pendingRecording) {
    state.pendingRecording = file;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file); drawRecording();
  }
  await saveDraft(explicitRetry);
  if (!state.pendingRecordingAssetId) {
    const asset = await uploadAsset(file, 'audio');
    state.pendingRecordingAssetId = asset.id;
  }
  if (state.project.recordingAssetId !== state.pendingRecordingAssetId) {
    state.draft.recordingAssetId = state.pendingRecordingAssetId; mark('recordingAssetId'); await saveDraft();
  }
  state.markerDirty = false; state.markers.clear(); state.extras = []; drawMarkers();
  if (state.pendingRecording === file) {
    state.pendingRecording = null; state.pendingRecordingAssetId = null;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null; $('retry-recording').hidden = true; drawRecording();
  }
  notice('整段录音保存好了。接下来可以交给助手，或自动对台词。');
}
function drawRecording() {
  const id = state.project.recordingAssetId;
  const player = $('recording-player');
  if (state.pendingRecording && state.objectUrl) {
    player.hidden = false;
    if (player.getAttribute('src') !== state.objectUrl) player.src = state.objectUrl;
    $('recording-info').textContent = '刚才的完整录音还保留在这个页面，尚未成功保存。请点“重试保存”，先不要关闭或刷新页面。';
    $('retry-recording').hidden = false;
    return;
  }
  player.hidden = !id;
  if (id) {
    const url = assetUrl(state.project.id, id);
    if (player.getAttribute('src') !== url) { player.pause(); player.src = url; }
    const asset = state.project.assets.find(a => a.id === id);
    const duration = asset?.metadata?.duration;
    $('recording-info').textContent = `完整原始录音已保留${Number.isFinite(duration) ? ` · ${duration.toFixed(1)} 秒` : ''}。这里播放的是原录音，不是逐幕小录音。`;
  } else { player.removeAttribute('src'); $('recording-info').textContent = '还没有录音。上传或录制一整段就好。'; }
}
async function startRecording() {
  if (state.pendingRecording) { notice('刚才的完整录音还没保存，请先重试保存，不必重录。', 'warning'); return; }
  await saveDraft();
  if (state.project.recordingAssetId && !confirm('录一个新的完整版本？原来的录音仍保留在历史版本中。')) return;
  document.querySelectorAll('audio,video').forEach(media => media.pause());
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(state.stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { notice('录音没有顺利完成。可以上传已有录音，或请大人检查麦克风。', 'error'); releaseRecording(); };
    recorder.onstop = () => {
      const mime = recorder.mimeType || type || 'audio/webm';
      releaseRecording();
      const blob = new Blob(chunks, { type: mime });
      const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([blob], `完整录音.${extension}`, { type: mime });
      state.pendingRecording = file;
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = URL.createObjectURL(file); drawRecording();
      task(() => uploadRecording(file));
    };
    state.recorder = recorder; state.recordingStarted = Date.now(); recorder.start(1000);
    $('stop-recording').hidden = false; $('start-recording').hidden = true;
    state.recordTimer = setInterval(() => { $('recording-status').textContent = `正在录一整段 · ${Math.floor((Date.now() - state.recordingStarted) / 1000)} 秒`; }, 500);
    $('recording-status').textContent = '正在录一整段…';
  } catch {
    releaseRecording(); notice('还不能使用麦克风。请允许麦克风权限，或上传已有的一整段录音。', 'warning');
  }
}
function releaseRecording() {
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.recorder = null;
  clearInterval(state.recordTimer); state.recordTimer = null;
  $('stop-recording').hidden = true; $('start-recording').hidden = false; $('recording-status').textContent = '';
  controls();
}
function drawAlignment() {
  const holder = $('alignment-status'); holder.replaceChildren();
  const alignment = state.project?.alignment;
  if (!state.health?.render?.ready) holder.append(node('p', '制作工具还没准备好：预览和正式电影暂时不能制作，请请大人检查工作室。'));
  if (!state.health?.agent?.configured) holder.append(node('p', '导演助手还没有配置；下面的预览按钮只是直接制作，不代表助手已经工作。'));
  if (!state.health?.alignment?.configured) holder.append(node('p', '自动听录音暂时没准备好。请请大人配置本地识别，或展开“人工时间标记”。'));
  if (!alignment) { holder.append(node('p', '录音还没有和台词对齐。先自动对齐，或请大人帮助标记每句的时间。')); return; }
  const missing = (alignment.utterances || []).filter(u => u.start === null || u.end === null || u.matchStatus === 'unmatched');
  const review = (alignment.utterances || []).filter(u => u.matchStatus === 'needs_review');
  const sourceLabel = alignment.method === 'provided_segments' ? '时间来源：人工 / 已提供的文字时间标记，不是自动语音识别。' : ['local_whisper', 'local_vosk'].includes(alignment.method) ? '时间来源：本地语音识别。听错的字不会替换你的原台词。' : '时间来源需要确认：这组时间不能直接当作自动识别结果，请和原录音核对。';
  holder.append(node('p', sourceLabel));
  holder.append(node('p', hasMissingAlignment() ? `还有 ${missing.length || '一些'} 句台词没找到时间，暂时不能制作。` : '每句台词都有时间了，可以先做预览。'));
  if (review.length) holder.append(node('p', `${review.length} 句需要再听一听确认，正式制作前请检查。`));
  if (alignment.unmatchedSpeech?.length) holder.append(node('p', `录音里还有 ${alignment.unmatchedSpeech.length} 段额外的话，会保留，不能当作安静剪掉。`));
  if (alignment.warnings?.length) {
    holder.append(node('p', '提醒：标记和识别都可能有遗漏；未标注的声音并不等于安静，请和原录音核对。'));
    const notes = node('details'); notes.append(node('summary', `查看 ${alignment.warnings.length} 条对齐提醒`));
    const warnings = node('ul');
    for (const warning of alignment.warnings.slice(0, 30)) {
      const message = typeof warning === 'string' ? warning : warning?.message;
      if (typeof message !== 'string') continue;
      const internal = /[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var)\/|api[_-]?key|token|secret/i.test(message);
      warnings.append(node('li', internal ? '有一条工作室配置提醒，请请大人检查。' : message.slice(0, 500)));
    }
    notes.append(warnings); holder.append(notes);
  }
  const details = node('details'); details.append(node('summary', '核对台词和听到的文字'));
  const list = node('ul');
  for (const scene of state.project.scenes) for (const dialogue of scene.dialogue) {
    const found = alignment.utterances?.find(u => u.dialogueId === dialogue.id);
    const line = node('li'); line.append(node('strong', `原台词：${dialogue.text}`), node('div', `听到 / 提供的文字：${found?.recognizedText || '尚未匹配'}`));
    list.append(line);
  }
  for (const speech of alignment.unmatchedSpeech || []) list.append(node('li', `额外的话（${speech.start.toFixed(2)}–${speech.end.toFixed(2)} 秒）：${speech.text}`));
  details.append(list); holder.append(details);
}
function markerTime(label, marker, key) {
  const group = node('label', label);
  const row = node('div', null, { class: 'marker-time' });
  const field = node('input', null, { type: 'number', min: '0', step: '0.01', value: marker[key] ?? '', 'aria-label': label });
  field.addEventListener('input', () => { state.markerDirty = true; marker[key] = field.value === '' ? null : Number(field.value); });
  row.append(field, button('取当前时间', () => {
    const time = $('recording-player').currentTime;
    if (!Number.isFinite(time)) return;
    state.markerDirty = true; marker[key] = Math.round(time * 100) / 100; field.value = marker[key];
  }, 'quiet', `${label}使用录音当前时间`)); group.append(row); return group;
}
function drawMarkers() {
  const holder = $('markers'); holder.replaceChildren();
  for (const [sceneIndex, scene] of state.draft.scenes.entries()) for (const dialogue of scene.dialogue) {
    if (!state.markers.has(dialogue.id)) {
      const found = state.project.alignment?.utterances?.find(u => u.dialogueId === dialogue.id);
      state.markers.set(dialogue.id, { start: found?.start ?? null, end: found?.end ?? null });
    }
    const marker = state.markers.get(dialogue.id);
    const row = node('div', null, { class: 'marker-row', 'data-marker-id': dialogue.id });
    row.append(node('p', `第 ${sceneIndex + 1} 幕 · ${dialogue.text || '还没写台词'}`), markerTime('开始（秒）', marker, 'start'), markerTime('结束（秒）', marker, 'end'));
    holder.append(row);
  }
  if (!holder.children.length) holder.append(node('p', '先在照片下面写几句台词，再来标记时间。', { class: 'muted' }));
  drawExtraMarkers();
}
function drawExtraMarkers() {
  const holder = $('extra-markers'); holder.replaceChildren();
  state.extras.forEach(extra => {
    const row = node('div', null, { class: 'marker-row extra' });
    row.append(input('额外说了什么', extra.text, value => { state.markerDirty = true; extra.text = value; }, { maxlength: '1000', placeholder: '写下实际说的话' }), markerTime('额外话开始（秒）', extra, 'start'), markerTime('额外话结束（秒）', extra, 'end'),
      button('×', () => { state.markerDirty = true; state.extras = state.extras.filter(item => item.id !== extra.id); drawExtraMarkers(); }, 'quiet', '移除额外标记'));
    holder.append(row);
  });
}
async function submitMarkers() {
  await saveDraft();
  const segments = [];
  for (const scene of state.project.scenes) for (const dialogue of scene.dialogue) {
    if (!dialogue.text.trim()) continue;
    const marker = state.markers.get(dialogue.id);
    if (!marker || !Number.isFinite(marker.start) || !Number.isFinite(marker.end) || marker.end <= marker.start || marker.start < 0) {
      notice('请给每句台词填写真实的开始和结束时间；结束要晚于开始。没有说到的句子请先修改故事本，不要猜时间。', 'warning'); return;
    }
    segments.push({ dialogueId: dialogue.id, start: marker.start, end: marker.end, text: dialogue.text });
  }
  for (const extra of state.extras) {
    if (!extra.text.trim() || !Number.isFinite(extra.start) || !Number.isFinite(extra.end) || extra.start < 0 || extra.end <= extra.start) {
      notice('额外的话也需要写下实际文字和正确的开始、结束时间。', 'warning'); return;
    }
    segments.push({ start: extra.start, end: extra.end, text: extra.text });
  }
  segments.sort((a, b) => a.start - b.start);
  if (segments.some((s, i) => i && s.start < segments[i - 1].end)) { notice('有两段时间重叠了，请按完整录音的先后顺序检查。', 'warning'); return; }
  const duration = $('recording-player').duration;
  if (Number.isFinite(duration) && segments.some(s => s.end > duration + .01)) { notice('有一句结束时间超过了整段录音，请再检查一下。', 'warning'); return; }
  const job = await api(projectPath('/align'), { method: 'POST', body: { expectedRevision: state.project.revision, engine: 'segments', segments } });
  state.markerDirty = false;
  addJob(job); notice('已经提交人工标记。这里使用你提供的台词，不会把它说成自动识别。');
}
function addJob(job) {
  state.jobs = [job, ...state.jobs.filter(j => j.id !== job.id)]; drawJobs(); controls();
  clearTimeout(state.timer); state.timer = setTimeout(() => pollJobs(state.generation), 900);
}
async function alignAutomatically() {
  await saveDraft();
  addJob(await api(projectPath('/align'), { method: 'POST', body: { expectedRevision: state.project.revision } }));
  notice('开始在本地听整段录音、对台词。没有找到的话会标出来，不会凭空编造识别结果。');
}
async function makeMovie(preview) {
  await saveDraft();
  if (hasMissingAlignment()) { drawAlignment(); notice(ERRORS.ALIGNMENT_INCOMPLETE, 'warning'); return; }
  const review = state.project.alignment?.utterances?.some(u => u.matchStatus === 'needs_review');
  if (!preview && review && !confirm('有些台词时间还需要检查。你已经听过录音并愿意制作这一版吗？')) return;
  addJob(await api(projectPath('/render'), { method: 'POST', body: { expectedRevision: state.project.revision, preview } }));
  notice(preview ? '正在直接制作预览。这不是助手对故事的自动修改。' : '正在制作正式电影，会保留当前故事版本。');
}
async function sendAgent(feedback = false) {
  // Capture the displayed export BEFORE saving can redraw the movie player.
  const watched = state.watched && { ...state.watched, currentTime: Number.isFinite($('movie-player').currentTime) ? $('movie-player').currentTime : null };
  const viewing = watched ? `当前观看电影：assetId=${watched.assetId}；inputRevision=${watched.inputRevision}；currentTime=${watched.currentTime} 秒。请按这部电影的时间索引理解，不要猜当前故事的时间。` : '当前观看电影：assetId=null；inputRevision=null；currentTime=null（尚未观看电影，不能按秒定位）。';
  await saveDraft();
  const prompt = $(feedback ? 'feedback' : 'agent-prompt').value.trim();
  if (feedback && !prompt) { notice('先告诉助手你想改哪一点吧。', 'warning'); return; }
  const result = await api(projectPath('/agent'), { method: 'POST', body: { expectedRevision: state.project.revision,
    prompt: feedback ? `${prompt}\n\n${viewing}` : prompt || '请尊重我的故事和逐图台词，用这一整段录音把照片丰富成纸艺电影。先检查准备情况，保留额外的话，说明不确定之处，再制作可预览的电影。' } });
  if (!safeId(result?.sessionId)) throw { code: 'AGENT_UNAVAILABLE' };
  $('agent-status').textContent = '已交给导演助手，正在查询真实工作状态。不代表电影已经完成；下面会显示实际制作任务和结果。';
  notice(feedback ? '修改想法已交给助手。旧电影和原素材都会保留。' : '助手收到你的故事了。让我们等它真正完成制作。');
  clearTimeout(state.timer); state.timer = setTimeout(() => pollJobs(state.generation), 900);
}
async function refreshReview(generation = state.generation) {
  const projectId = state.project?.id;
  if (!projectId || generation !== state.generation) return;
  const request = ++state.reviewRequest;
  try {
    const review = await api(`/projects/${encodeURIComponent(projectId)}/review`);
    if (generation !== state.generation || request !== state.reviewRequest || state.project?.id !== projectId) return;
    state.review = review;
    drawReview(); controls();
  } catch {
    if (generation === state.generation && request === state.reviewRequest) {
      $('agent-status').textContent = '暂时连不上助手状态，不能判断助手是否仍在工作。制作任务另列在下方。';
      $('review-cards').replaceChildren(node('p', '待确认修改暂时无法刷新，请稍后再试。'));
    }
  }
}
function drawReview() {
  const agent = state.review?.agent;
  const labels = { running: '正在整理你的电影', idle: '这一轮已停下，看看下面的回复', cold: '暂时没有运行，不会自行开始新任务' };
  const reasons = { completed: '这一轮回复已结束。', aborted: '这一轮已取消。', blocked: '有问题需要确认。', error: '这一轮没能完成，请让大人检查设置。', 'max-tokens': '这次回复达到长度限制。', interrupted: '这一轮被中断了。' };
  const status = labels[agent?.liveStatus] || '正在检查状态';
  const pending = state.review?.proposals?.length ? '有剪辑建议等你试听确认。' : '';
  $('agent-status').dataset.liveStatus = agent?.liveStatus || 'unknown';
  $('agent-status').textContent = `导演助手：${status}。${reasons[agent?.lastTurnReason] || ''}${pending}电影做好后，会出现在下方播放器里。`;
  const messages = $('agent-messages'); messages.replaceChildren();
  let budget = 8000;
  const recent = [];
  for (const message of (Array.isArray(agent?.messages) ? agent.messages : []).slice(-10).reverse()) {
    if (!budget || typeof message?.text !== 'string' || !message.text.trim()) continue;
    const text = publicText(message.text, Math.min(2000, budget)); budget -= text.length;
    recent.unshift({ text, interrupted: message.interrupted === true });
  }
  for (const message of recent) {
    const text = message.text;
    const reply = node('div', null, { class: 'agent-reply' });
    reply.append(node('p', text));
    if (message.interrupted === true) reply.append(node('small', '这条回复被中断，可能还没说完。'));
    messages.append(reply);
  }
  if (!messages.children.length) messages.append(node('p', '暂时没有可见的助手回复。工具任务是否排队、进行或失败，请看下方实际制作任务；没有回复不代表完成。', { class: 'muted' }));
  const cards = $('review-cards'); cards.replaceChildren();
  for (const proposal of (Array.isArray(state.review?.proposals) ? state.review.proposals : []).slice(0, 20)) {
    if (!safeId(proposal?.id)) continue;
    const card = node('article', null, { class: 'review-card', 'data-proposal-id': proposal.id });
    const seconds = value => Number.isFinite(value) ? `${value.toFixed(2)} 秒` : '未知';
    card.append(node('h4', '这段停顿要剪短吗？'), node('p', `原停顿：${seconds(proposal.currentSeconds)} → 新停顿：${seconds(proposal.targetSeconds)}`), node('p', '试听只播放完整原始录音中的这一段，不是剪短后的效果。'));
    const warnings = node('ul');
    for (const warning of (Array.isArray(proposal.warnings) ? proposal.warnings : []).slice(0, 10)) {
      const text = publicText(typeof warning === 'string' ? warning : warning?.message, 500);
      if (text) warnings.append(node('li', text));
    }
    if (warnings.children.length) card.append(warnings);
    const actions = node('div', null, { class: 'action-row' });
    const listen = button('试听原段', () => playSnippet(proposal), 'secondary');
    listen.dataset.reviewAction = 'listen'; listen.dataset.playable = String(validSourceRange(proposal.sourceRange));
    const apply = button('确认剪短', () => task(() => decideReview(proposal, 'apply')), 'primary'); apply.dataset.reviewAction = 'apply';
    const dismiss = button('保留原样', () => task(() => decideReview(proposal, 'dismiss')), 'quiet'); dismiss.dataset.reviewAction = 'dismiss';
    actions.append(listen, apply, dismiss); card.append(actions); cards.append(card);
  }
}
function validSourceRange(range) {
  return Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.start >= 0 && range.end > range.start && range.end <= 600;
}
function stopSnippet(pause = true) {
  clearTimeout(state.snippetTimer); state.snippetTimer = null;
  if (!state.snippet) return;
  state.snippet = null;
  if (pause) $('recording-player').pause();
}
function checkSnippet() {
  const snippet = state.snippet;
  if (!snippet) return;
  const player = $('recording-player');
  if (player.getAttribute('src') !== snippet.src || player.currentTime >= snippet.end || player.currentTime < snippet.start - .05 || player.ended) { stopSnippet(); return; }
  clearTimeout(state.snippetTimer);
  // timeupdate is coarse; the timer also bounds playback at the original segment end.
  state.snippetTimer = setTimeout(checkSnippet, Math.min(100, Math.max(10, (snippet.end - player.currentTime) * 1000 / Math.max(.1, player.playbackRate))));
}
async function playSnippet(proposal) {
  const range = proposal.sourceRange, player = $('recording-player');
  if (!validSourceRange(range) || state.recorder || state.pendingRecording || !state.project.recordingAssetId || state.review?.revision !== state.project.revision) return;
  const src = assetUrl(state.project.id, state.project.recordingAssetId);
  if (player.getAttribute('src') !== src) return;
  if (Number.isFinite(player.duration) && range.end > player.duration + .01) { notice('原录音区间超出了录音长度，暂时不能试听。', 'warning'); return; }
  stopSnippet();
  const snippet = { start: range.start, end: range.end, src }; state.snippet = snippet;
  try {
    player.currentTime = range.start;
    await player.play();
    if (state.snippet === snippet) checkSnippet();
  } catch {
    if (state.snippet === snippet) { stopSnippet(); notice('原段暂时无法播放。请等原录音加载好后再试。', 'warning'); }
  }
}
async function decideReview(proposal, decision) {
  const projectId = state.project.id, generation = state.generation, expectedRevision = state.review?.revision;
  if (decision === 'apply' && !confirm('确认把这段停顿剪短吗？请先听原段并检查提醒；如果包含额外说的话，它们也可能被剪掉。原始录音仍会保留。')) return;
  stopSnippet();
  try {
    const project = await api(`/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(proposal.id)}`, { method: 'POST', body: { expectedRevision, decision } });
    if (generation !== state.generation) return;
    // Keep author inputs, selection, markers, and unsaved recording untouched. The
    // next safe poll may load the new Project; dirty drafts keep their base revision.
    if (!state.conflictPending && !state.dirty.size && !state.markerDirty && !state.recorder && !state.pendingRecording) acceptProject(project);
    notice(decision === 'apply' ? '已确认剪短。原始录音保留；新电影还需要实际制作。未保存的想法仍留在原处。' : '已保留原样。未保存的想法仍留在原处。');
  } catch (error) {
    if (error?.status !== 409 && error?.code !== 'REVISION_CONFLICT') throw error;
    await rememberConflict();
    notice('这张确认卡已过期，没有应用修改。已刷新待确认卡片；你正在编辑的内容和录音没有被覆盖。请点“保存”并明确确认后再保存想法。', 'warning');
  }
  await refreshReview(generation);
}
const JOB_NAMES = { align: '对齐整段录音', render: '制作电影', narration: '制作旁白' };
const JOB_STATES = { queued: '排队中', running: '进行中', succeeded: '完成', failed: '没有完成', cancelled: '已取消', interrupted: '被中断，请重新检查' };
function drawJobs() {
  const holder = $('jobs'); holder.replaceChildren();
  if (!state.jobs.length) holder.append(node('p', '目前没有制作工具任务。尚无电影结果时，不能把助手停下当作电影完成。', { class: 'muted' }));
  for (const job of state.jobs.slice(0, 8)) {
    const card = node('div', null, { class: 'job-card', 'data-job-id': job.id });
    const top = node('div', null, { class: 'job-top' });
    top.append(node('strong', `${JOB_NAMES[job.kind] || '制作任务'} · ${JOB_STATES[job.status] || '等待状态'}`));
    if (ACTIVE.has(job.status)) {
      const cancel = button('取消任务', () => task(async () => {
        await api(`/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: {} }); await pollJobs(state.generation);
      }), 'quiet'); cancel.dataset.cancelJob = job.id; top.append(cancel);
    }
    card.append(top);
    if (ACTIVE.has(job.status)) card.append(node('progress', null, { max: '1', value: Math.max(0, Math.min(1, Number(job.progress) || 0)), 'aria-label': '制作进度' }));
    if (job.error) card.append(node('p', friendly(job.error)));
    if (job.result?.applied === false) card.append(node('p', '任务基于以前的版本完成，没有盖掉你的新修改。请检查版本后重新制作。'));
    card.append(node('p', `基于故事本第 ${job.revision} 版`, { class: 'muted' }));
    holder.append(card);
  }
}
async function pollJobs(generation) {
  clearTimeout(state.timer);
  if (!state.project || generation !== state.generation) return;
  const projectId = state.project.id;
  try {
    const [jobs] = await Promise.all([api(`/jobs?projectId=${encodeURIComponent(projectId)}`), refreshReview(generation)]);
    if (generation !== state.generation || state.project.id !== projectId) return;
    state.jobs = jobs;
    const completed = jobs.filter(j => j.status === 'succeeded' && !state.seenJobs.has(j.id));
    jobs.filter(j => !ACTIVE.has(j.status) && j.status !== 'succeeded').forEach(j => state.seenJobs.add(j.id));
    const newerReview = state.review?.revision > state.project.revision;
    if ((completed.length || newerReview) && canRefreshProject()) {
      const project = await api(`/projects/${encodeURIComponent(projectId)}`);
      if (generation === state.generation && canRefreshProject() && project.revision >= state.project.revision) {
        state.markers.clear(); acceptProject(project); completed.forEach(job => state.seenJobs.add(job.id)); await listProjects();
      }
    } else if ((completed.length || newerReview) && (state.dirty.size || state.markerDirty)) notice('制作任务或故事本有新结果。你的未保存输入保持不变；请先处理这些想法，再查看新版本。', 'warning');
    drawJobs(); controls();
  } catch { if (generation === state.generation) $('agent-status').textContent = '暂时连不上制作进度，稍后会再试。没有把断线当成制作完成。'; }
  finally { if (generation === state.generation) state.timer = setTimeout(() => pollJobs(generation), 1800); }
}
function drawMovie() {
  const entries = [...(state.project.exports || [])].reverse();
  const latest = entries.find(entry => safeId(entry.assetId));
  const movie = $('movie-player');
  movie.hidden = !latest; $('movie-empty').hidden = !!latest;
  if (!latest) { state.watched = null; movie.pause(); movie.removeAttribute('src'); $('movie-info').textContent = ''; return; }
  state.watched = { assetId: latest.assetId, inputRevision: Number.isSafeInteger(latest.inputRevision) ? latest.inputRevision : null };
  const url = assetUrl(state.project.id, latest.assetId);
  if (movie.getAttribute('src') !== url) { movie.pause(); movie.src = url; }
  $('movie-info').textContent = `${latest.preview ? '预览电影' : '已完成的电影'}${latest.inputRevision ? ` · 来自故事本第 ${latest.inputRevision} 版` : ''}。请先看一看、听一听，再告诉助手想改什么。`;
}
async function loadHistory() {
  const history = await api(projectPath('/history'));
  const holder = $('history-list'); holder.replaceChildren();
  for (const entry of history.slice(0, 30)) {
    const row = node('div', null, { class: 'history-row' });
    row.append(node('span', `第 ${entry.revision} 版${entry.revision === state.project.revision ? ' · 当前版本' : ''}`));
    if (entry.revision !== state.project.revision) row.append(button('恢复为新版本', () => task(async () => {
      if (!confirm(`恢复第 ${entry.revision} 版？当前未保存的想法将放下，已保存的版本会全部保留。`)) return;
      const project = await api(projectPath('/restore'), { method: 'POST', body: { expectedRevision: state.project.revision, revision: entry.revision } });
      state.markers.clear(); state.extras = []; acceptProject(project); await listProjects(); await loadHistory(); notice('以前的故事已经恢复为新版本。');
    }), 'quiet'));
    holder.append(row);
  }
}
async function refreshHealth() {
  try {
    state.health = await api('/health');
    const ready = !!state.health.render?.ready;
    $('readiness').textContent = ready ? (state.health.agent?.configured ? '制作工具和导演助手已就位' : '制作工具就绪 · 助手待配置') : '工作室还需要大人帮忙准备';
    $('readiness').className = `chip ${ready ? 'ready' : ''}`;
  } catch { state.health = null; $('readiness').textContent = '暂时连不上工作室'; $('readiness').className = 'chip'; }
  if (state.project) drawAlignment(); controls();
}
for (const key of ['title', 'story']) $(key).addEventListener('input', () => { state.draft[key] = $(key).value; mark(key); });
for (const key of ['director', 'voice']) $(key).addEventListener('input', () => { state.draft.credits[key] = $(key).value; mark('credits'); });
$('save').addEventListener('click', () => task(async () => { await saveDraft(true); notice('新的想法保存好啦。'); }));
$('new-project').addEventListener('click', () => task(createProject)); $('welcome-create').addEventListener('click', () => task(createProject));
$('refresh-health').addEventListener('click', refreshHealth);
$('add-character').addEventListener('click', () => { state.draft.characters.push({ id: uid(), name: '新角色', color: '#317a72' }); mark('characters'); drawCharacters(); drawScenes(); controls(); });
$('photo-files').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; if (files.length) task(() => uploadPhotos(files)); });
$('audio-file').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; if (file) task(() => uploadRecording(file)); });
$('start-recording').addEventListener('click', () => task(startRecording));
$('stop-recording').addEventListener('click', () => { if (state.recorder?.state === 'recording') state.recorder.stop(); });
$('retry-recording').addEventListener('click', () => { if (state.pendingRecording) task(() => uploadRecording(state.pendingRecording, true)); });
$('auto-align').addEventListener('click', () => task(alignAutomatically));
$('preview').addEventListener('click', () => task(() => makeMovie(true))); $('export').addEventListener('click', () => task(() => makeMovie(false)));
$('agent-create').addEventListener('click', () => task(() => sendAgent(false))); $('send-feedback').addEventListener('click', () => task(() => sendAgent(true)));
$('submit-markers').addEventListener('click', () => task(submitMarkers));
$('add-extra-marker').addEventListener('click', () => { state.markerDirty = true; state.extras.push({ id: uid(), text: '', start: null, end: null }); drawExtraMarkers(); });
$('load-history').addEventListener('click', () => task(loadHistory));
$('manual-markers').addEventListener('toggle', () => { if ($('manual-markers').open && state.project) drawMarkers(); });
for (const event of ['timeupdate', 'seeking', 'ratechange']) $('recording-player').addEventListener(event, checkSnippet);
for (const event of ['pause', 'ended', 'emptied']) $('recording-player').addEventListener(event, () => { if ($('recording-player').paused || $('recording-player').ended) stopSnippet(false); });
document.addEventListener('play', event => {
  if (!(event.target instanceof HTMLMediaElement)) return;
  // pause() changes the media flag synchronously, but its event arrives later.
  // Clear the snippet BEFORE another player pauses it, so immediate manual
  // playback cannot be stopped by a stale range timer/seeking handler.
  if (event.target !== $('recording-player')) stopSnippet();
  document.querySelectorAll('audio,video').forEach(media => { if (media !== event.target) media.pause(); });
}, true);
window.addEventListener('beforeunload', event => { if (state.dirty.size || state.markerDirty || state.recorder || state.pendingRecording) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { stopPolling(); clearInterval(state.recordTimer); state.stream?.getTracks().forEach(track => track.stop()); });
await Promise.all([refreshHealth(), listProjects().catch(error => notice(friendly(error), 'error'))]);
