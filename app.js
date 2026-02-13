/*
Web Music Score Pitch Editor
- Render with OpenSheetMusicDisplay (OSMD)
- Load .musicxml/.xml or .mxl (zip) using JSZip
- Navigation with Left/Right including rests
- Up/Down chromatic semitone steps (Up = sharp, Down = flat)
- Cmd+Up/Down octave (mac only per spec)
- Treble range clamp C3 (48) .. F6 (89)
- Tied notes treated as a single editable unit
- Export preserving non-pitch XML; only modify note pitch tags
*/

const RANGE_MIN_MIDI = 48; // C3
const RANGE_MAX_MIDI = 89; // F6

// Simple hash for remembering selection per score
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// Find the selected playable index (note only). If current is a rest, search forward then backward.
function getSelectedPlayableIndex() {
  const n = state.selectable.length;
  let idx = state.index || 0;
  const isNote = i => state.selectable[i] && state.selectable[i].type === 'note';
  if (isNote(idx)) return idx;
  for (let i = idx + 1; i < n; i++) if (isNote(i)) return i;
  for (let i = idx - 1; i >= 0; i--) if (isNote(i)) return i;
  return 0;
}

function computeVisualTimes(bpm) {
  const visual = getVisualPositions(state.parsed);
  const visualWithSwing = applySwingOffsetsToPositions(visual.positions, visual.divisions, 0.62);
  const times = visualWithSwing.map(div => div * (60 / bpm) / visual.divisions);
  return { times, nodes: visual.nodes, divisions: visual.divisions };
}

// Resolve the starting visual index and times from the current selection
function getStartFromSelection(bpm) {
  const selIdx = getSelectedPlayableIndex();
  const sel = state.selectable[selIdx];
  const targetNodes = (sel && Array.isArray(sel.domNodes)) ? sel.domNodes : [];
  const visual = computeVisualTimes(bpm);
  let visualIdx = 0;
  // Find the first visual position that corresponds to one of the selected DOM nodes
  for (let i = 0; i < visual.nodes.length; i++) {
    const n = visual.nodes[i];
    if (targetNodes.includes(n)) { visualIdx = i; break; }
  }
  return { visualTimes: visual.times, visualIdx };
}

// Reset per-song Game Mode snapshots but keep the enabled flag intact
function resetGameModeSnapshots() {
  state.gameMode.originalXmlString = "";
  state.gameMode.originalNoteMidiByXmlIndex = new Map();
  state.gameMode.currentNoteMidiByXmlIndex = new Map();
  state.gameMode.gameXmlString = "";
}

// Timeline and mapping infrastructure for gamification
function computeVisualTimesSec() {
  const vt = computeVisualTimes(state.transportBPM || 120);
  const times = vt?.times || [];
  const sec = (times.length && times[0] > 300) ? times.map(t => t/1000) : times;
  return { times: sec, nodes: vt?.nodes, divisions: vt?.divisions };
}

function computeDurBeatsForSelectable(sel) {
  let beats = 0;
  const notes = sel.domNodes || [];
  for (const noteNode of notes) {
    if (noteNode.querySelector && noteNode.querySelector('grace')) continue; // skip grace notes
    const dur = +(noteNode.querySelector?.('duration')?.textContent || 0);
    const div = +(noteNode.closest?.('measure')?.querySelector('divisions')?.textContent || 1);
    beats += div ? dur/div : 0;
  }
  return beats || 0;
}

function buildVisualSelMaps() {
  const visualNodes = state.audio?.visualTimes?.nodes || [];
  const map = []; // visualIdx -> selIndex
  
  // Build mapping using existing XML index bridge
  visualNodes.forEach((node, vIdx) => {
    if (!node || !node.getAttribute) return;
    const xmlIndex = parseInt(node.getAttribute('data-xml-node-index') || '-1');
    if (xmlIndex >= 0 && state.xmlToSelIndex) {
      const selIdx = state.xmlToSelIndex.get(xmlIndex);
      if (selIdx != null) map[vIdx] = selIdx;
    }
  });
  
  state.maps.visualToSel = map;
  
  // Build reverse mapping (first visual index per selectable)
  state.maps.selToVisual = [];
  map.forEach((selIdx, vIdx) => {
    if (selIdx != null && state.maps.selToVisual[selIdx] == null) {
      state.maps.selToVisual[selIdx] = vIdx;
    }
  });
}

function rebuildTimeline() {
  if (!state.selectable?.length) return;
  
  const visualTimes = computeVisualTimesSec();
  state.audio.visualTimes = visualTimes;
  
  buildVisualSelMaps();
  
  const durBeats = computeDurBeatsForSelectable();
  const msBySel = [];
  const refSecBySel = [];
  const metaBySel = [];
  
  state.selectable.forEach((sel, idx) => {
    const vIdx = state.maps.selToVisual[idx];
    const startSec = (vIdx != null && visualTimes.times[vIdx] != null) ? visualTimes.times[vIdx] : 0;
    const durSec = durBeats[idx] ? (durBeats[idx] * 60) / (state.transportBPM || 120) : 0;
    
    msBySel[idx] = startSec * 1000;
    refSecBySel[idx] = startSec;
    metaBySel[idx] = { duration: durSec };
  });
  
  state.timeline = { msBySel, refSecBySel, metaBySel };
}

// Checkpoint system functions
function buildCheckpoints() {
  if (!state.selectable?.length || !state.timeline) return [];
  
  const checkpoints = [];
  let currentStart = 0;
  let noteCount = 0;
  const maxNotesPerCheckpoint = 12;
  
  for (let i = 0; i < state.selectable.length; i++) {
    const sel = state.selectable[i];
    const isRest = sel.domNodes?.[0]?.classList?.contains('vf-rest') || 
                   sel.domNodes?.[0]?.tagName?.toLowerCase() === 'rest';
    
    noteCount++;
    
    // Create checkpoint on rest or when we hit max notes
    if (isRest || noteCount >= maxNotesPerCheckpoint || i === state.selectable.length - 1) {
      const startTime = state.timeline.refSecBySel[currentStart] || 0;
      const endTime = (state.timeline.refSecBySel[i] || 0) + (state.timeline.metaBySel[i]?.duration || 0);
      
      checkpoints.push({
        start: currentStart,
        end: i,
        startTime,
        endTime,
        noteCount: i - currentStart + 1
      });
      
      currentStart = i + 1;
      noteCount = 0;
    }
  }
  
  return checkpoints.length ? checkpoints : [{
    start: 0,
    end: state.selectable.length - 1,
    startTime: state.timeline.refSecBySel[0] || 0,
    endTime: (state.timeline.refSecBySel[state.selectable.length - 1] || 0) + 
             (state.timeline.metaBySel[state.selectable.length - 1]?.duration || 0),
    noteCount: state.selectable.length
  }];
}

function getCurrentCheckpoint() {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled || !gamify.checkpoints?.length) return null;
  return gamify.checkpoints[gamify.current] || null;
}

function navigateCheckpoint(direction) {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled || !gamify.checkpoints?.length) return;
  
  if (direction === 'prev' && gamify.current > 0) {
    gamify.current--;
  } else if (direction === 'next' && gamify.current < gamify.checkpoints.length - 1) {
    gamify.current++;
  } else if (direction === 'retry') {
    // Reset current checkpoint progress
    gamify.streak = 0;
  }
  
  // Move selection to checkpoint start
  const checkpoint = getCurrentCheckpoint();
  if (checkpoint) {
    state.currentIndex = checkpoint.start;
    updateHUD();
    updateSelectionDisplay();
  }
}

// HUD management functions
function initializeGamification() {
  if (!state.gameMode.enabled || !state.selectable?.length) return;
  
  const gamify = state.gameMode.gamify;
  gamify.enabled = true;
  gamify.checkpoints = buildCheckpoints();
  gamify.current = 0;
  gamify.score = 0;
  gamify.streak = 0;
  gamify.hits = 0;
  gamify.total = 0;
  gamify.startedAt = Date.now();
  gamify.elapsedMs = 0;
  
  // Generate persistence key
  const fileContent = state.gameMode.gameXmlString || state.originalXmlString || '';
  gamify.fileKey = `gamify_${hashString(fileContent)}_${state.selectable.length}`;
  
  loadProgress();
  updateHUD();
  bindHUDEvents();
  showHUD();
}

function showHUD() {
  const hud = document.getElementById('gamification-hud');
  if (hud) hud.style.display = 'block';
}

function hideHUD() {
  const hud = document.getElementById('gamification-hud');
  if (hud) hud.style.display = 'none';
  unbindHUDEvents();
}

function updateHUD() {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled) return;
  
  const checkpoint = getCurrentCheckpoint();
  const accuracy = gamify.total > 0 ? Math.round((gamify.hits / gamify.total) * 100) : 0;
  const grade = getGrade(accuracy);
  
  // Update display elements
  const scoreEl = document.getElementById('gamify-score');
  const streakEl = document.getElementById('gamify-streak');
  const accuracyEl = document.getElementById('gamify-accuracy');
  const gradeEl = document.getElementById('gamify-grade');
  const checkpointEl = document.getElementById('gamify-checkpoint');
  
  if (scoreEl) scoreEl.textContent = gamify.score;
  if (streakEl) streakEl.textContent = `${gamify.streak} (Best: ${gamify.bestStreak})`;
  if (accuracyEl) accuracyEl.textContent = `${accuracy}%`;
  if (gradeEl) gradeEl.textContent = grade;
  if (checkpointEl && checkpoint) {
    checkpointEl.textContent = `${gamify.current + 1} / ${gamify.checkpoints.length}`;
  }
  
  // Update button states
  const prevBtn = document.getElementById('gamify-prev');
  const nextBtn = document.getElementById('gamify-next');
  
  if (prevBtn) prevBtn.disabled = gamify.current <= 0;
  if (nextBtn) nextBtn.disabled = gamify.current >= gamify.checkpoints.length - 1;
}

function bindHUDEvents() {
  const prevBtn = document.getElementById('gamify-prev');
  const nextBtn = document.getElementById('gamify-next');
  const retryBtn = document.getElementById('gamify-retry');
  
  if (prevBtn) prevBtn.addEventListener('click', () => navigateCheckpoint('prev'));
  if (nextBtn) nextBtn.addEventListener('click', () => navigateCheckpoint('next'));
  if (retryBtn) retryBtn.addEventListener('click', () => navigateCheckpoint('retry'));
}

function unbindHUDEvents() {
  const prevBtn = document.getElementById('gamify-prev');
  const nextBtn = document.getElementById('gamify-next');
  const retryBtn = document.getElementById('gamify-retry');
  
  if (prevBtn) prevBtn.replaceWith(prevBtn.cloneNode(true));
  if (nextBtn) nextBtn.replaceWith(nextBtn.cloneNode(true));
  if (retryBtn) retryBtn.replaceWith(retryBtn.cloneNode(true));
}

function getGrade(accuracy) {
  if (accuracy >= 95) return 'A+';
  if (accuracy >= 90) return 'A';
  if (accuracy >= 85) return 'B+';
  if (accuracy >= 80) return 'B';
  if (accuracy >= 75) return 'C+';
  if (accuracy >= 70) return 'C';
  if (accuracy >= 65) return 'D+';
  if (accuracy >= 60) return 'D';
  return 'F';
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// Transport loop constraints for gamification
function getCheckpointTimeWindow() {
  const checkpoint = getCurrentCheckpoint();
  if (!checkpoint) return null;
  
  return {
    startTime: checkpoint.startTime,
    endTime: checkpoint.endTime,
    duration: checkpoint.endTime - checkpoint.startTime
  };
}

function constrainReferenceAudioToCheckpoint() {
  const window = getCheckpointTimeWindow();
  if (!window || !state.audio.referenceAudio) return;
  
  const audio = state.audio.referenceAudio;
  
  // Set current time to checkpoint start
  audio.currentTime = window.startTime;
  
  // Add event listener to loop at checkpoint end
  const onTimeUpdate = () => {
    if (audio.currentTime >= window.endTime) {
      audio.currentTime = window.startTime;
    }
  };
  
  // Remove existing listener if any
  if (state.audio.checkpointTimeUpdateListener) {
    audio.removeEventListener('timeupdate', state.audio.checkpointTimeUpdateListener);
  }
  
  // Add new listener
  state.audio.checkpointTimeUpdateListener = onTimeUpdate;
  audio.addEventListener('timeupdate', onTimeUpdate);
}

function removeReferenceAudioConstraints() {
  if (state.audio.referenceAudio && state.audio.checkpointTimeUpdateListener) {
    state.audio.referenceAudio.removeEventListener('timeupdate', state.audio.checkpointTimeUpdateListener);
    state.audio.checkpointTimeUpdateListener = null;
  }
}

function constrainMidiTransportToCheckpoint() {
  const timeWindow = getCheckpointTimeWindow();
  if (!timeWindow || !window.Tone) return;
  
  // Schedule transport to loop at checkpoint boundaries
  const loopStart = timeWindow.startTime;
  const loopEnd = timeWindow.endTime;
  
  if (window.Tone.Transport) {
    window.Tone.Transport.loopStart = loopStart;
    window.Tone.Transport.loopEnd = loopEnd;
    window.Tone.Transport.loop = true;
  }
}

function removeMidiTransportConstraints() {
  if (window.Tone && window.Tone.Transport) {
    window.Tone.Transport.loop = false;
    window.Tone.Transport.loopStart = 0;
    window.Tone.Transport.loopEnd = 0;
  }
}

// MIDI scheduling constraints for gamification
function filterEventsForCheckpoint(events, divisions, bpm) {
  const checkpoint = getCurrentCheckpoint();
  if (!checkpoint || !state.gameMode.gamify.enabled) return events;
  
  const secPerDiv = (60 / bpm) / divisions;
  const checkpointStartTime = checkpoint.startTime;
  const checkpointEndTime = checkpoint.endTime;
  
  return events.filter(ev => {
    const eventTime = ev.startDiv * secPerDiv;
    return eventTime >= checkpointStartTime && eventTime <= checkpointEndTime;
  });
}

// Scoring system for gamification
function scoreNote(selIndex, playedMidi) {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled || !state.gameMode.enabled) return;
  
  const checkpoint = getCurrentCheckpoint();
  if (!checkpoint || selIndex < checkpoint.start || selIndex > checkpoint.end) return;
  
  // Get original MIDI for this note
  const originalMidi = state.gameMode.originalNoteMidiByXmlIndex?.get(selIndex);
  if (originalMidi == null) return; // Skip rests or unmapped notes
  
  gamify.total++;
  
  const isCorrect = playedMidi === originalMidi;
  if (isCorrect) {
    gamify.hits++;
    gamify.streak++;
    gamify.score += 10 + Math.min(gamify.streak, 50); // Base 10 + streak bonus up to 50
    gamify.bestStreak = Math.max(gamify.bestStreak, gamify.streak);
  } else {
    gamify.streak = 0; // Reset streak on wrong note
  }
  
  updateHUD();
  
  // Check if checkpoint is complete
  if (isCheckpointComplete(checkpoint)) {
    onCheckpointComplete();
  }
}

function isCheckpointComplete(checkpoint) {
  if (!checkpoint) return false;
  
  // Count notes (non-rests) in checkpoint range
  let notesInCheckpoint = 0;
  let notesPlayed = 0;
  
  for (let i = checkpoint.start; i <= checkpoint.end; i++) {
    const sel = state.selectable[i];
    const isRest = sel?.domNodes?.[0]?.classList?.contains('vf-rest') || 
                   sel?.domNodes?.[0]?.tagName?.toLowerCase() === 'rest';
    
    if (!isRest) {
      notesInCheckpoint++;
      // Check if this note has been played (has current MIDI mapping)
      if (state.gameMode.currentNoteMidiByXmlIndex?.has(i)) {
        notesPlayed++;
      }
    }
  }
  
  return notesPlayed >= notesInCheckpoint;
}

function onCheckpointComplete() {
  const gamify = state.gameMode.gamify;
  const checkpoint = getCurrentCheckpoint();
  
  if (!checkpoint) return;
  
  // Save progress
  saveProgress();
  
  // Auto-advance to next checkpoint if available
  if (gamify.current < gamify.checkpoints.length - 1) {
    setTimeout(() => {
      navigateCheckpoint('next');
    }, 1000); // Brief delay to show completion
  } else {
    // All checkpoints complete
    setTimeout(() => {
      alert(`Congratulations! You completed all checkpoints!\nFinal Score: ${gamify.score}\nAccuracy: ${Math.round((gamify.hits / gamify.total) * 100)}%`);
    }, 1000);
  }
}

// Hook into cursor advance for scoring
function onCursorAdvance(newIndex, oldIndex) {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled || !state.audio.midiPlaying) return;
  
  // Score the note that was just played (oldIndex)
  if (oldIndex != null && oldIndex >= 0) {
    const currentMidi = state.gameMode.currentNoteMidiByXmlIndex?.get(oldIndex);
    if (currentMidi != null) {
      scoreNote(oldIndex, currentMidi);
    }
  }
}

// Persistence system for gamification
function saveProgress() {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled || !gamify.fileKey) return;
  
  const progressData = {
    bestScore: gamify.score,
    bestStreak: gamify.bestStreak,
    bestAccuracy: gamify.total > 0 ? Math.round((gamify.hits / gamify.total) * 100) : 0,
    checkpointsCompleted: gamify.current,
    totalCheckpoints: gamify.checkpoints.length,
    lastPlayed: Date.now()
  };
  
  try {
    localStorage.setItem(gamify.fileKey, JSON.stringify(progressData));
  } catch (e) {
    console.warn('Failed to save gamification progress:', e);
  }
}

function loadProgress() {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled || !gamify.fileKey) return;
  
  try {
    const saved = localStorage.getItem(gamify.fileKey);
    if (saved) {
      const progressData = JSON.parse(saved);
      // Load best records for display, but don't overwrite current session
      gamify.bestStreak = Math.max(gamify.bestStreak, progressData.bestStreak || 0);
    }
  } catch (e) {
    console.warn('Failed to load gamification progress:', e);
  }
}

// Gamification lifecycle integration
function enterGamificationMode() {
  if (!state.gameMode.enabled) return;
  
  // Ensure timeline and maps are built
  rebuildTimeline();
  
  // Initialize gamification
  initializeGamification();
  
  // Apply transport constraints if in playback
  if (state.audio.midiPlaying) {
    constrainMidiTransportToCheckpoint();
  }
  if (state.audio.referenceAudio && !state.audio.referenceAudio.paused) {
    constrainReferenceAudioToCheckpoint();
  }
}

function exitGamificationMode() {
  const gamify = state.gameMode.gamify;
  if (!gamify.enabled) return;
  
  // Save final progress
  saveProgress();
  
  // Clean up constraints
  removeMidiTransportConstraints();
  removeReferenceAudioConstraints();
  
  // Hide HUD and clean up
  hideHUD();
  
  // Reset gamification state
  gamify.enabled = false;
  gamify.score = 0;
  gamify.streak = 0;
  gamify.hits = 0;
  gamify.total = 0;
  gamify.current = 0;
  gamify.checkpoints = [];
}

// --- Score scroll lock helpers ---
let __scrollLockCount = 0;
function __preventWheel(e){ e.preventDefault(); e.stopPropagation(); }

function lockScoreScroll() {
  const el = els.stageWrapper;
  if (!el) return;
  if (__scrollLockCount === 0) {
    el.dataset.prevOverflow = el.style.overflow || '';
    el.style.overflow = 'hidden';          // hide both scrollbars
    el.style.overscrollBehavior = 'contain';
    el.classList.add('editing');           // optional (see CSS below)
    el.addEventListener('wheel', __preventWheel, { passive: false });
    el.addEventListener('touchmove', __preventWheel, { passive: false });
  }
  __scrollLockCount++;
}

function unlockScoreScroll() {
  const el = els.stageWrapper;
  if (!el) return;
  __scrollLockCount = Math.max(0, __scrollLockCount - 1);
  if (__scrollLockCount === 0) {
    el.style.overflow = el.dataset.prevOverflow || 'auto';
    el.style.overscrollBehavior = '';
    el.classList.remove('editing');
    el.removeEventListener('wheel', __preventWheel);
    el.removeEventListener('touchmove', __preventWheel);
    delete el.dataset.prevOverflow;
  }
}

// Mouse drag state for pitch editing
let dragState = {
  isDragging: false,
  startY: 0,
  currentY: 0,
  targetElement: null,
  originalIndex: -1,
  accumulatedDelta: 0
};

// Handle mouse drag for pitch editing
function handleMouseDragPitchEdit(e) {
  if (!dragState.isDragging) return;
  
  e.preventDefault();
  e.stopPropagation();
  
  dragState.currentY = e.clientY;
  const deltaY = dragState.startY - dragState.currentY; // Inverted: up = positive
  
  // Convert pixel movement to semitone changes (every 10 pixels = 1 semitone)
  const totalDelta = Math.floor(deltaY / 10);
  const newDelta = totalDelta - dragState.accumulatedDelta;
  
  if (newDelta !== 0) {
    dragState.accumulatedDelta = totalDelta;
    editCurrent(newDelta, newDelta > 0); // positive = sharp preference
  }
}

// Start mouse drag for pitch editing
function startMouseDragPitchEdit(e, element) {
  // First, select the note that was clicked
  const selIndex = element.getAttribute('data-sel-index');
  if (selIndex != null) {
    const idx = parseInt(selIndex, 10);
    if (!Number.isNaN(idx) && idx >= 0 && idx < state.selectable.length) {
      setSelectionAndShow(idx, { scroll: false });
    }
  }
  
  const sel = state.selectable[state.index];
  if (!sel || sel.type === 'rest') return; // Only allow dragging on notes
  
  dragState.isDragging = true;
  dragState.startY = e.clientY;
  dragState.currentY = e.clientY;
  dragState.targetElement = element;
  dragState.originalIndex = state.index;
  dragState.accumulatedDelta = 0;
  
  // Change cursor to indicate dragging mode
  document.body.style.cursor = 'ns-resize';
  
  // Lock scroll during drag to prevent interference
  lockScoreScroll();
  
  // Add global mouse move and mouse up listeners
  document.addEventListener('mousemove', handleMouseDragPitchEdit, { passive: false });
  document.addEventListener('mouseup', stopMouseDragPitchEdit, { passive: false });
  
  // Add escape handlers for when mouse leaves window or window loses focus
  window.addEventListener('blur', stopMouseDragPitchEdit, { passive: false });
  document.addEventListener('visibilitychange', stopMouseDragPitchEdit, { passive: false });
  window.addEventListener('mouseleave', stopMouseDragPitchEdit, { passive: false });
  
  e.preventDefault();
  e.stopPropagation();
}

// Stop mouse drag for pitch editing
function stopMouseDragPitchEdit(e) {
  if (!dragState.isDragging) return;
  
  dragState.isDragging = false;
  dragState.targetElement = null;
  dragState.originalIndex = -1;
  dragState.accumulatedDelta = 0;
  
  // Restore cursor
  document.body.style.cursor = '';
  
  // Unlock scroll after drag
  unlockScoreScroll();
  
  // Remove global listeners
  document.removeEventListener('mousemove', handleMouseDragPitchEdit);
  document.removeEventListener('mouseup', stopMouseDragPitchEdit);
  
  // Remove escape handlers
  window.removeEventListener('blur', stopMouseDragPitchEdit);
  document.removeEventListener('visibilitychange', stopMouseDragPitchEdit);
  window.removeEventListener('mouseleave', stopMouseDragPitchEdit);
  
  // Prevent the click event from firing after drag to avoid sound feedback
  // Set a flag to prevent sound on the next selection
  window.__preventNextSound = true;
  setTimeout(() => {
    window.__preventNextSound = false;
  }, 50);
  
  e.preventDefault();
  e.stopPropagation();
}

function createEnhancedPianoFallback(ctx) {
  // A very small, zero-dependency synth that approximates a piano envelope and timbre
  //  - 2 detuned oscillators + 1 sine for body
  //  - fast attack, short decay, medium release
  //  - gentle lowpass to reduce harshness
  function notePlay(midi, when = ctx.currentTime, opts = {}) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const gain = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(6000, when);
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.setValueAtTime(freq, when);
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.detune.setValueAtTime(+7, when); o2.frequency.setValueAtTime(freq, when);
    const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.setValueAtTime(freq, when);
    o1.connect(lp); o2.connect(lp); o3.connect(lp);
    lp.connect(gain).connect(ctx.destination);
    const vel = ((opts && opts.gain != null) ? opts.gain : 0.08) * (state.audio.masterGain ?? 0.8); // Much quieter fallback
    // ADSR-like envelope
    const a = 0.004, d = 0.12, s = 0.15, r = 0.25;
    gain.gain.cancelScheduledValues(when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel), when + a);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel * s), when + a + d);
    // Auto-note length ~0.8s, then release
    const off = when + 0.8;
    gain.gain.setTargetAtTime(0.0001, off, r);
    o1.start(when); o2.start(when); o3.start(when);
    o1.stop(off + r * 4); o2.stop(off + r * 4); o3.stop(off + r * 4);
    return { stop: (t) => { const tt = t || ctx.currentTime; try { o1.stop(tt); o2.stop(tt); o3.stop(tt); } catch(_) {} } };
  }
  return { __isFallback: true, play: notePlay };
}

// Play sound feedback for current selection
async function playCurrentNoteSound() {
  const sel = state.selectable[state.index];
  if (!sel || sel.type === 'rest') return; // no sound for rests
  
  // Get MIDI pitch from the first note in the selection
  const firstNote = sel.domNodes[0];
  const midi = noteXmlToMidi(firstNote);
  if (midi == null) return;
  
  // Ensure audio is initialized
  if (!state.audio.piano) {
    try {
      await initAudio();
    } catch (e) {
      console.warn('Could not initialize audio for note feedback:', e);
      return;
    }
  }
  
  // Play the note with volume controlled by master volume slider
  if (state.audio.piano && state.audio.piano.play) {
    try {
      // Use the same gain as MIDI playback, controlled by masterGain
      const feedbackGain = 0.8 * (state.audio.masterGain ?? 0.8); // Match MIDI playback volume
      state.audio.piano.play(midi, state.audio.ctx.currentTime, { gain: feedbackGain });
    } catch (e) {
      console.warn('Could not play note feedback:', e);
    }
  }
}

// ---------- Selection coloring (MusicXML-level) ----------
// These functions are no longer needed with the new CSS-based selection system

// NEW, EFFICIENT VERSION
async function applySelectionColor(opts = {}) {
  const { scroll = false } = opts;

  // Remove the highlight from any previously selected notes
  const previouslySelected = els.stage.querySelectorAll('.selected-note-group');
  previouslySelected.forEach(el => {
    el.classList.remove('selected-note-group');
  });

  // Get the data for the currently selected item
  const sel = state.selectable[state.index];
  if (!sel) return;

  // For tied notes, highlight ALL notes in the tie chain
  if (sel.type === 'note' && sel.domNodes && sel.domNodes.length > 1) {
    // This is a tied note group - highlight all visual representations
    sel.domNodes.forEach(noteNode => {
      // Find all SVG elements that correspond to this XML note
      const svgElements = els.stage.querySelectorAll(`[data-xml-node-index]`);
      svgElements.forEach(svgEl => {
        const xmlIndex = svgEl.getAttribute('data-xml-node-index');
        if (xmlIndex && state.xmlToSelIndex && state.xmlToSelIndex.get(parseInt(xmlIndex)) === state.index) {
          svgEl.classList.add('selected-note-group');
        }
      });
    });
  } else {
    // Single note or rest - use the existing logic
    const targetGroup = els.stage.querySelector(`[data-sel-index="${state.index}"]`);
    if (targetGroup) {
      targetGroup.classList.add('selected-note-group');
    }
  }

  // If the selection was triggered by a key press, scroll the first highlighted element into view
  if (scroll) {
    const firstHighlighted = els.stage.querySelector('.selected-note-group');
    if (firstHighlighted) {
      firstHighlighted.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'center'
      });
    }
  }
}

const state = {
  osmd: null,
  speed: 1.0, // Speed multiplier (0.01 to 1.0)
  swing: 0.62, // Swing ratio (0.5 = straight, 0.67 = medium swing, 0.75 = heavy swing)
  gameMode: {
    enabled: false,
    originalXmlString: "",             // snapshot before G4 transform
    originalNoteMidiByXmlIndex: new Map(), // xmlIndex -> midi (null for rests)
    // recomputed right before ref-audio play:
    currentNoteMidiByXmlIndex: new Map(),
    // save game progress:
    gameXmlString: "",                 // current game state XML
    gamify: {
      enabled: false,
      mode: 'checkpoint',       // 'checkpoint' | 'accuracy' | 'timetrial'
      // scoring
      score: 0,
      streak: 0,
      bestStreak: 0,
      hits: 0,
      total: 0,
      // checkpoints (index ranges in selectable space)
      checkpoints: [],          // [{ startSel, endSel }]
      current: 0,
      // timing
      startedAt: 0,             // performance.now()
      elapsedMs: 0,
      // persistence key
      fileKey: null,            // e.g. `${state.fileHash}|${state.selectable.length}`
    }
  },
  audio: {

    ctx: null,
    piano: null,
    engine: null, // 'tone' or 'fallback'
    isLoading: false,
    hasPlayedBefore: false,
    referenceAudio: null, // HTML Audio element for reference playback
    midiPlaying: false,
    scheduledNotes: [], // Track scheduled notes for pause/stop functionality
    // Visual cursor sync state
    playheadAnimationId: null,
    visualTimes: null,
    cursorIndex: 0
  },
  align: { audioFile: null, audioUrl: null, audioBuf: null, timeMap: null, rafId: 0, visualTimes: null },
  timeline: { msBySel: [], refSecBySel: [], metaBySel: [] },
  maps: { visualToSel: [], selToVisual: [] },

  originalIsMXL: false,
  zip: null, // JSZip instance when .mxl
  xmlPathInZip: null, // path to main score xml inside .mxl
  xmlString: null, // current working XML string
  originalXmlString: null,
  parsed: null, // DOM Document
  selectable: [], // flat list of events (notes and rests). Each item: {type:'note'|'rest', noteIds:[...], voiceId, measureIndex, domNodes:[...]} 
  selectedIndex: 0,
  lastHash: '',
  index: 0,
  fileHash: null,
  lastHighlighted: [],
  // optional global mapping (not used after per-measure mapping fix)
  headMap: [],
  overlayEl: null,
  selectionColor: '#16A34A',
  useXmlSelectionColor: true,
};

const els = {
  exportBtn: document.getElementById('exportBtn'),
  status: document.getElementById('status'),
  stageWrapper: document.getElementById('stageWrapper'),
  stage: document.getElementById('stage'),
  midiToggleBtn: document.getElementById('midiToggleBtn'),
  speedSlider: document.getElementById('speedSlider'),
  speedValue: document.getElementById('speedValue'),
  swingSlider: document.getElementById('swingSlider'),
  swingValue: document.getElementById('swingValue'),
  songList: document.getElementById('songList'),
  volumeSlider: document.getElementById('volumeSlider'),
  volumeValue: document.getElementById('volumeValue'),
  // Layout sliders
  zoomSlider: document.getElementById('zoomSlider'),
  zoomValue: document.getElementById('zoomValue'),

  refPlayBtn: document.getElementById('refPlayBtn'),
  refToggleBtn: document.getElementById('refToggleBtn'),
  syncStatus: document.getElementById('syncStatus'),
}
;

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  els.status.className = 'status' + (isError ? ' error' : '');
}

function focusStage() {
  // Ensure the stage wrapper can receive focus and prevent scrolling
  if (els.stageWrapper) {
    els.stageWrapper.focus({ preventScroll: true });
    // Also ensure it has proper tabindex for focus
    if (!els.stageWrapper.hasAttribute('tabindex')) {
      els.stageWrapper.setAttribute('tabindex', '0');
    }
  }
}

// Parse MusicXML string to DOM
function parseXml(xmlStr) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('MusicXML parse error');
  return doc;
}

// Serialize DOM back to string
function serializeXml(doc) {
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

// Remove all explicit accidentals; let OSMD compute per-measure accidentals
function stripAllAccidentals(doc) {
  doc.querySelectorAll('note > accidental').forEach(a => a.remove());
}

// Key-aware accidental normalizer that follows standard notation rules
function recomputeAccidentalsFromPitch(doc){
  const SHARP_ORDER = ['F','C','G','D','A','E','B'];
  const FLAT_ORDER  = ['B','E','A','D','G','C','F'];

  function defaultAlterForStep(fifths){
    const m = {};
    if (fifths > 0) SHARP_ORDER.slice(0, fifths).forEach(s => m[s] = 1);
    if (fifths < 0) FLAT_ORDER.slice(0, -fifths).forEach(s => m[s] = -1);
    return m;
  }

  const parts = doc.querySelectorAll('score-partwise > part, part');
  parts.forEach(part => {
    let currentFifths = 0;
    part.querySelectorAll('measure').forEach(measure => {
      const f = measure.querySelector('attributes > key > fifths');
      if (f) currentFifths = parseInt(f.textContent || '0', 10) || 0;

      const base = defaultAlterForStep(currentFifths);
      const memory = Object.create(null); // step+octave -> last alter in THIS measure

      measure.querySelectorAll('note').forEach(note => {
        if (note.querySelector('rest')) return;
        const stepEl   = note.querySelector('pitch > step');
        const alterEl  = note.querySelector('pitch > alter');
        const octEl    = note.querySelector('pitch > octave');
        if (!stepEl || !octEl) return;

        const step  = stepEl.textContent || 'C';
        const oct   = octEl.textContent || '4';
        const alter = parseInt(alterEl?.textContent || '0', 10) || 0;

        const key = step + '|' + oct;
        const prev = key in memory ? memory[key] : (base[step] || 0);

        // remove any existing accidental tag first
        const oldAcc = note.querySelector('accidental');
        if (oldAcc) oldAcc.remove();

        if (alter !== prev) {
          const acc = note.ownerDocument.createElement('accidental');
          acc.textContent = alter === 0 ? 'natural'
                        : alter === 1 ? 'sharp'
                        : alter === 2 ? 'double-sharp'
                        : alter === -1 ? 'flat'
                        : 'double-flat';
          note.appendChild(acc);
        }
        memory[key] = alter;
      });
    });
  });
}

// Insert a forced line break every N measures via MusicXML <print new-system="yes"/>
function enforceFourPerSystem(doc, N = 4) {
  const isTimewise = !!doc.querySelector('score-timewise');
  if (isTimewise) {
    const measures = Array.from(doc.querySelectorAll('score-timewise > measure'));
    if (!measures.length) return;
    measures.forEach(m => {
      Array.from(m.querySelectorAll('print')).forEach(p => {
        if (p.hasAttribute('new-system') || p.hasAttribute('new-page')) p.remove();
      });
    });
    measures.forEach((m, i) => {
      if (i % N === 0) {
        const p = doc.createElement('print');
        p.setAttribute('new-system', 'yes');
      // Optionally hint measure width by setting a dummy layout directive OSMD ignores safely
        m.insertBefore(p, m.firstChild);
      }
    });
    return;
  }
  const parts = Array.from(doc.querySelectorAll('score-partwise > part, part'));
  if (!parts.length) return;
  for (const part of parts) {
    const measures = Array.from(part.querySelectorAll('measure'));
    measures.forEach(m => {
      Array.from(m.querySelectorAll('print')).forEach(p => {
        if (p.hasAttribute('new-system') || p.hasAttribute('new-page')) p.remove();
      });
    });
    measures.forEach((m, i) => {
      if (i % N === 0) {
        const p = doc.createElement('print');
        p.setAttribute('new-system', 'yes');
        m.insertBefore(p, m.firstChild);
      }
    });
  }
}

// Debug: log how many measures OSMD placed per system to verify 4-per-line
function logSystemMeasureCounts(label) {
  try {
    const systems = els.stage.querySelectorAll('g.systems, g.system');
    const measureGroups = els.stage.querySelectorAll('g[id^="measure_"], g[id^="measure-"]');
    // Fallback: count by x positions grouped by system parent
    const counts = [];
    measureGroups.forEach(mg => {
      const sys = mg.closest('g.systems, g.system') || mg.parentElement;
      const idx = Array.from(systems).indexOf(sys);
      counts[idx] = (counts[idx] || 0) + 1;
    });
    console.log('[SYSTEM-MEASURE-COUNTS]', label, counts.filter(Boolean));
  } catch (e) {
    console.warn('logSystemMeasureCounts failed', e);
  }
}

// Return array of measure counts per system for a given container (defaults to main stage)
function getSystemMeasureCounts(containerEl = els.stage) {
  try {
    const systems = containerEl.querySelectorAll('g.systems, g.system');
    const measureGroups = containerEl.querySelectorAll('g[id^="measure_"], g[id^="measure-"]');
    const counts = [];
    measureGroups.forEach(mg => {
      const sys = mg.closest('g.systems, g.system') || mg.parentElement;
      const idx = Array.from(systems).indexOf(sys);
      counts[idx] = (counts[idx] || 0) + 1;
    });
    return counts.filter(c => typeof c === 'number');
  } catch (_) {
    return [];
  }
}

// Iteratively shrink zoom/spacing until all systems (except possibly the last) have 4 measures
async function enforceFourPerSystemPostLayout(osmdInstance, containerEl = els.stage) {
  const maxIterations = 12;
  let zoom = osmdInstance.Zoom || 1.0;
  for (let i = 0; i < maxIterations; i++) {
    const counts = getSystemMeasureCounts(containerEl);
    if (!counts.length) break;
    const lastIdx = counts.length - 1;
    const badIdx = counts.findIndex((c, idx) => c !== 4 && idx < lastIdx);
    if (badIdx === -1) break;
    // Tighten: reduce zoom slightly, and spacing if available
    zoom = Math.max(0.6, zoom * 0.93);
    osmdInstance.Zoom = zoom;
    if (osmdInstance.rules && typeof osmdInstance.rules.SpacingFactor === 'number') {
      osmdInstance.rules.SpacingFactor = Math.max(0.5, osmdInstance.rules.SpacingFactor * 0.93);
    }
    await osmdInstance.render();
  }
}

// Utilities: pitch <-> midi conversions with spelling preference
const STEP_ORDER = ['C','D','E','F','G','A','B'];
const STEP_TO_SEMITONE = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

function noteXmlToMidi(noteEl) {
  // For rests, returns null
  if (noteEl.querySelector('rest')) return null;
  const pitch = noteEl.querySelector('pitch');
  if (!pitch) return null;
  const step = pitch.querySelector('step')?.textContent;
  const alter = parseInt(pitch.querySelector('alter')?.textContent || '0', 10);
  const octave = parseInt(pitch.querySelector('octave')?.textContent || '4', 10);
  const semitone = (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter; // MIDI formula
  return semitone;
}

function midiToPitchSpelling(midi, preferSharps) {
  // preferSharps: true for upward motion, false for downward
  const octave = Math.floor(midi / 12) - 1;
  const semitone = midi % 12;
  // Two maps for enharmonic preference
  const sharpMap = {
    0:['C',0], 1:['C',1], 2:['D',0], 3:['D',1], 4:['E',0], 5:['F',0], 6:['F',1], 7:['G',0], 8:['G',1], 9:['A',0], 10:['A',1], 11:['B',0]
  };
  const flatMap = {
    0:['C',0], 1:['D',-1], 2:['D',0], 3:['E',-1], 4:['E',0], 5:['F',0], 6:['G',-1], 7:['G',0], 8:['A',-1], 9:['A',0], 10:['B',-1], 11:['B',0]
  };
  const [step, alter] = (preferSharps ? sharpMap : flatMap)[semitone];
  return { step, alter, octave };
}

function setNotePitchXml(noteEl, midi, preferSharps) {
  const pitchEl = noteEl.querySelector('pitch') || noteEl.ownerDocument.createElement('pitch');
  if (!noteEl.querySelector('pitch')) {
    // ensure removing <rest> if present (shouldn't for notes), but keep safe
    const restEl = noteEl.querySelector('rest');
    if (restEl) restEl.remove();
    noteEl.insertBefore(pitchEl, noteEl.firstChild);
  }
  const { step, alter, octave } = midiToPitchSpelling(midi, preferSharps);
  let stepEl = pitchEl.querySelector('step');
  let alterEl = pitchEl.querySelector('alter');
  let octaveEl = pitchEl.querySelector('octave');
  if (!stepEl) { stepEl = noteEl.ownerDocument.createElement('step'); pitchEl.appendChild(stepEl); }
  if (!octaveEl) { octaveEl = noteEl.ownerDocument.createElement('octave'); pitchEl.appendChild(octaveEl); }
  stepEl.textContent = step;
  octaveEl.textContent = String(octave);
  if (alter === 0) {
    if (alterEl) alterEl.remove();
  } else {
    if (!alterEl) { alterEl = noteEl.ownerDocument.createElement('alter'); pitchEl.insertBefore(alterEl, octaveEl); }
    alterEl.textContent = String(alter);
  }
  // Remove any explicit accidental tag to let OSMD compute accidentals from pitch/key
  const accEl = noteEl.querySelector('accidental');
  if (accEl) accEl.remove();
}

function clampMidi(m) {
  return Math.min(RANGE_MAX_MIDI, Math.max(RANGE_MIN_MIDI, m));
}

// Build a flat selectable list from MusicXML DOM: includes notes and rests in sequence order.
function buildSelectable(doc) {
  const result = [];
  const parts = Array.from(doc.querySelectorAll('score-partwise > part, score-timewise > part, part'));
  // Monophonic leadsheet assumption: use first part only
  const part = parts[0];
  if (!part) return result;
  const measures = Array.from(part.querySelectorAll('measure'));
  let voiceCounter = 1; // default voice id if not present

  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    const entries = Array.from(measure.children).filter(ch => ch.tagName === 'note' || ch.tagName === 'backup' || ch.tagName === 'forward' || ch.tagName === 'attributes');
    // Iterate notes; ignore grace notes / ornaments
    const notes = Array.from(measure.querySelectorAll('note'));
    for (const note of notes) {
      if (note.querySelector('grace')) continue; // ignore grace notes
      const isRest = !!note.querySelector('rest');
      const tieEls = Array.from(note.querySelectorAll('tie'));
      const voiceId = note.querySelector('voice')?.textContent || String(voiceCounter);
      if (isRest) {
        result.push({ type: 'rest', domNodes: [note], measureIndex: mi, voiceId });
      } else {
        // Group tied notes as a single selectable item (start->...->stop)
        // If this note has tie type="stop" only, it will be included by its chain started earlier; skip creating a new group
        const hasStart = tieEls.some(t => t.getAttribute('type') === 'start');
        const hasStop = tieEls.some(t => t.getAttribute('type') === 'stop');
        const isContinuationOnly = !hasStart && hasStop;
        if (isContinuationOnly) continue;
        const chain = [note];
        if (hasStart) {
          // Follow subsequent notes in same voice where <tie type="stop"/> continues
          let current = note;
          while (true) {
            // Find the next note element in DOM order in this part
            const next = nextNoteElement(current, part);
            if (!next) break;
            const nextVoice = next.querySelector('voice')?.textContent || voiceId;
            if (nextVoice !== voiceId) break;
            const nextTies = Array.from(next.querySelectorAll('tie'));
            if (!nextTies.length) break;
            chain.push(next);
            const contStart = nextTies.some(t => t.getAttribute('type') === 'start');
            const contStop = nextTies.some(t => t.getAttribute('type') === 'stop');
            if (!contStart && contStop) break; // last in chain
            if (!contStart && !contStop) break;
            current = next;
          }
        }
        result.push({ type: 'note', domNodes: chain, measureIndex: mi, voiceId });
      }
    }
  }
  return result;
}

function nextNoteElement(fromNode, partEl) {
  // Traverse DOM forward to find next <note> under the same <part>
  let n = fromNode;
  while (n) {
    if (n.nextSibling) {
      n = n.nextSibling;
      if (n.nodeType === 1) {
        if (n.tagName === 'note') return n;
        const found = n.querySelector && n.querySelector('note');
        if (found) return found;
      }
    } else {
      n = n.parentNode;
      if (!n || n === partEl) return null;
    }
  }
  return null;
}

async function loadFile(file) {
  resetState();
  
  // Preserve whether user had Game Mode on across song loads
  const shouldReapplyGameMode = state.gameMode.enabled;

  // Clear any snapshots tied to the previous song so toggling won't restore the old file
  resetGameModeSnapshots();
  
  setStatus('Loading...');
  const buf = await file.arrayBuffer();
  const ext = file.name.toLowerCase().split('.').pop();
  try {
    if (ext === 'mxl') {
      state.originalIsMXL = true;
      state.zip = await JSZip.loadAsync(buf);
      // find main xml: look for container.xml first
      let xmlPath = null;
      const container = state.zip.file('META-INF/container.xml');
      if (container) {
        const containerXml = await container.async('text');
        const containerDoc = parseXml(containerXml);
        const rootfile = containerDoc.querySelector('rootfile');
        xmlPath = rootfile?.getAttribute('full-path') || null;
      }
      if (!xmlPath) {
        // fallback: first .xml that contains <score-partwise> or <score-timewise>
        const xmlFiles = Object.keys(state.zip.files).filter(p => p.toLowerCase().endsWith('.xml'));
        for (const p of xmlFiles) {
          const txt = await state.zip.file(p).async('text');
          if (txt.includes('<score-partwise') || txt.includes('<score-timewise')) { xmlPath = p; state.xmlString = txt; break; }
        }
      } else {
        state.xmlString = await state.zip.file(xmlPath).async('text');
      }
      if (!state.xmlString) throw new Error('Could not locate score XML in MXL');
      state.xmlPathInZip = xmlPath;
    } else {
      // treat as plain xml/musicxml
      const dec = new TextDecoder('utf-8');
      state.xmlString = dec.decode(buf);
      state.originalIsMXL = false;
    }

    state.originalXmlString = state.xmlString;
    state.parsed = parseXml(state.xmlString);
    stripAllAccidentals(state.parsed);
    recomputeAccidentalsFromPitch(state.parsed);
    enforceFourPerSystem(state.parsed, 4);
    state.xmlString = serializeXml(state.parsed);
    state.selectable = buildSelectable(state.parsed);
    if (state.selectable.length === 0) throw new Error('No notes or rests found');

    await renderCurrent();

    // Initial selection: first note of the first measure
    let idxFirstNoteInFirstMeasure = state.selectable.findIndex(e => e.type === 'note' && e.measureIndex === 0);
    let idxFirstNoteAnywhere = state.selectable.findIndex(e => e.type === 'note');
    state.index = (idxFirstNoteInFirstMeasure !== -1)
      ? idxFirstNoteInFirstMeasure
      : (idxFirstNoteAnywhere !== -1 ? idxFirstNoteAnywhere : 0);

    // Restore previous selection if available
    state.fileHash = hashString(state.originalXmlString);
    const saved = localStorage.getItem('sel_' + state.fileHash);
    if (saved) {
      const idx = parseInt(saved, 10);
      if (!Number.isNaN(idx) && idx >= 0 && idx < state.selectable.length) state.index = idx;
    }
    await applySelectionColor({ scroll: true });

    // If Game Mode was enabled, re-apply it to the newly loaded song
    if (shouldReapplyGameMode) {
      // Prevent early-return inside enterGameMode()
      state.gameMode.enabled = false;
      await enterGameMode(); // will snapshot the *current* song and convert notes to G4
    }

    els.exportBtn.disabled = false;
    // Guard missing buttons
    if (els.midiToggleBtn) els.midiToggleBtn.disabled = false;
    setStatus('');
  } catch (e) {
    console.error(e);
    // Suppress user-facing error message here; keep console error for debugging
    setStatus('');
  }
}

function resetState() {
  // Don't null the OSMD instance - let renderCurrent reuse it
  // state.osmd = null;
  state.originalIsMXL = false;
  state.zip = null;
  state.xmlPathInZip = null;
  state.xmlString = null;
  state.originalXmlString = null;
  state.parsed = null;
  state.selectable = [];
  state.index = 0;
  state.fileHash = null;
  els.exportBtn.disabled = true;
}

async function renderCurrent() {
  if (!state.xmlString) return;
  setStatus('Rendering...');
  
  // Store scroll position before clearing stage to prevent reset
  const scrollTop = els.stageWrapper.scrollTop;
  const scrollLeft = els.stageWrapper.scrollLeft;
  
  // Clear any existing content to prevent scroll height accumulation
  els.stage.innerHTML = '';
  
  // If an OSMD object doesn't exist, create it. Otherwise, reuse it.
  if (!state.osmd) {
    state.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(els.stage, {
    autoResize: false,
    backend: 'svg',
    drawTitle: false,
    drawComposer: false,
    drawLyricist: false,
    // Force 4 measures per row for all scores
    measureNumberInterval: 4,
    systemMaxMeasures: 4,
    newSystemFromXML: true,
    newPageFromXML: false,
    // Disable automatic layout adjustments
    autoBeam: false,
    coloringEnabled: true,
    // Fixed spacing settings
    compactMode: false,
    followCursor: false
    });
  }
  await state.osmd.load(state.xmlString);
  
  // Minimal rules: respect XML breaks and keep 4 per system
  if (state.osmd.rules) {
    const r = state.osmd.rules;
    r.MaxMeasuresPerStaffLine = 4;
    r.MinMeasuresPerStaffLine = 4;
    r.NewSystemFromXML = true;
    r.NewPageFromXML = false;
    r.NewPageAtXMLNewPageTag = false;
    r.NewSystemAtXMLNewSystemTag = true;
    r.StretchLastSystemLine = true;
    r.CompactMode = true;
    // Give more horizontal room and reduce margins so 4 measures fit reliably
    try {
      r.PageFormat.width = Math.max(r.PageFormat.width || 1000, 2200);
      // don't force an absurd page height — let OSMD manage page breaks
      // r.PageFormat.height = Math.max(r.PageFormat.height || 0, 100000);
      r.SystemLeftMargin = 8;
      r.SystemRightMargin = 8;
      r.SystemLabelsRightMargin = 4;
      r.MeasureLeftMargin = 1;
      r.MeasureRightMargin = 1;
      if (typeof r.SpacingFactor === 'number') r.SpacingFactor = Math.min(r.SpacingFactor, 0.9);
    } catch (_) {}
  }
  // Set default zoom to 100%
  try { state.osmd.Zoom = 1.0; } catch(_) {}
  
  await state.osmd.render();
  await enforceFourPerSystemPostLayout(state.osmd, els.stage);
  try { logSystemMeasureCounts('full'); } catch(_) {}
  
  // Check if OSMD has built-in PlaybackManager
  console.log('OSMD PlaybackManager available:', !!state.osmd.PlaybackManager);
  if (state.osmd.PlaybackManager) {
    console.log('PlaybackManager methods:', Object.getOwnPropertyNames(state.osmd.PlaybackManager.constructor.prototype));
  }
  hideCreditsFromSvg();
  ensureSvgPointerEvents();
  // Build visual mapping and XML→selection map first
  rebuildGlyphNodeMap();
  buildXmlToSelIndexMap();
  // Tag click targets from XML mapping
  bindClickMapFromXmlIndex();
  // Optional: heuristic per-measure binder (kept to fill any gaps only)
  buildHeadMapAndBindClicks();
  enableDelegatedClickSelection();
  installGlobalClickDebug();
  installSvgHitHandler();
  installBeamHoverSync();
  installStemHoverSync();
  installStageObserverOnce();
  // Update button states after loading
  updateAllButtons();
  // Update game mode button text
  updateGameModeButton();
  // Restore scroll position after complete render
  requestAnimationFrame(() => {
    els.stageWrapper.scrollTop = scrollTop;
    els.stageWrapper.scrollLeft = scrollLeft;
  });
  
  // Keep focus
  focusStage();

  // Global keydown: route arrow keys to score even if focus is on buttons
  function isTypingTarget(t) {
    return !!(t && (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      t.isContentEditable
    ));
  }
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === ' ') {
      const tgt = e.target;
      if (isTypingTarget(tgt)) return; // let inputs handle their own arrows
      // If the target is already inside the stage, let the stage's handler process it once
      if (els.stageWrapper && els.stageWrapper.contains(tgt)) return;
      // Otherwise, route to score once
      e.preventDefault();
      e.stopPropagation();
      // Stop further listeners (including stage's) from also handling this key
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      focusStage();
      onKeyDown(e);
    }
  }, true);
}


function highlightSelection(shouldScroll = false) {
  // Remove previous highlights (restore original inline styles)
  for (const item of state.lastHighlighted) {
    if (!item) continue;
    const el = item.el || item; // backward compat
    if (!el) continue;
    if (el.classList) el.classList.remove('selected-note');
    if (item.prevStyle != null) {
      if (item.prevStyle === '__none__') {
        el.removeAttribute('style');
      } else {
        el.setAttribute('style', item.prevStyle);
      }
    } else {
      // legacy
      el.removeAttribute('data-highlighted');
    }
  }
  state.lastHighlighted = [];
  if (state.overlayEl && state.overlayEl.parentNode) {
    state.overlayEl.parentNode.removeChild(state.overlayEl);
  }
  state.overlayEl = null;

  const sel = state.selectable[state.index];
  if (!sel) return;

  // If we're using MusicXML <note color>, optionally scroll into view and exit.
  if (state.useXmlSelectionColor) {
    if (shouldScroll) {
      try {
        const gSel = els.stage.querySelector(`[data-sel-index="${state.index}"]`);
        if (gSel && gSel.scrollIntoView) {
          gSel.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        } else {
          const measureSvg = getMeasureSvg(sel.measureIndex);
          if (measureSvg && measureSvg.scrollIntoView) {
            measureSvg.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          }
        }
      } catch(_) {}
    }
    return;
  }

  // First try exact glyph mapped to this selection index
  try {
    const gSel = els.stage.querySelector(`[data-sel-index="${state.index}"]`);
    if (gSel) {
      if (shouldScroll) {
        try { gSel.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); } catch(_) {}
      }
      const headGroup = gSel.querySelector('g.vf-notehead, g[class*="notehead"]') || gSel;
      const paths = headGroup.querySelectorAll('path');
      if (paths.length) {
        paths.forEach(p => {
          const prev = p.getAttribute('style');
          state.lastHighlighted.push({ el: p, prevStyle: prev ?? '__none__' });
          const extra = 'fill:#16a34a !important; stroke:#16a34a !important; stroke-width:1.6px !important;';
          const prevStr = prev && prev !== '__none__' ? prev + '; ' : '';
          p.setAttribute('style', prevStr + extra);
          p.classList.add('selected-note');
        });
        return;
      }
    }
  } catch(_) {}
  // Optionally scroll to measure (support both measure_ and measure- ids from OSMD)
  if (shouldScroll) {
    const measureSvg = getMeasureSvg(sel.measureIndex);
    if (measureSvg && measureSvg.scrollIntoView) {
      measureSvg.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
  }
}

function saveSelectionIndex() {
  if (state.fileHash) localStorage.setItem('sel_' + state.fileHash, String(state.index));
}

function setSelectionAndShow(index, opts = {}) {
  const { scroll = false, playSound = true } = opts; // Changed default to false to prevent auto-scroll on clicks
  
  // Check if we should prevent sound (after drag operation)
  const shouldPlaySound = playSound && !window.__preventNextSound;
  
  // Log scroll position BEFORE selection
  const scrollBefore = {
    top: els.stageWrapper.scrollTop,
    left: els.stageWrapper.scrollLeft
  };
  
  console.log('[SCROLL-DEBUG] === SELECTION START ===');
  console.log('[SCROLL-DEBUG] Selected index:', index, 'scroll option:', scroll);
  console.log('[SCROLL-DEBUG] Scroll position BEFORE:', scrollBefore);
  
  console.log('[FULL-DEBUG] setSelectionAndShow called with index:', index, 'current state.index:', state.index);
  if (index < 0 || index >= state.selectable.length) {
    console.log('[FULL-DEBUG] Index out of bounds:', index, 'selectable length:', state.selectable.length);
    return;
  }
  const oldIndex = state.index;
  state.index = index;
  
  // Get selected element position
  const selectedEl = els.stage.querySelector(`[data-sel-index="${index}"]`);
  let selectedPosition = null;
  if (selectedEl) {
    const rect = selectedEl.getBoundingClientRect();
    const stageRect = els.stageWrapper.getBoundingClientRect();
    selectedPosition = {
      elementTop: rect.top,
      elementLeft: rect.left,
      relativeToStage: {
        top: rect.top - stageRect.top,
        left: rect.left - stageRect.left
      }
    };
    console.log('[SCROLL-DEBUG] Selected element position:', selectedPosition);
  }
  
  // Click intent vs final selection log
  try {
    if (window.__lastClickCtx__) {
      const ctx = window.__lastClickCtx__;
      const selectedDesc = describeSelectableAt(index);
      const clickedDesc = ctx.clickedDesc || ctx.pickedDesc || (ctx.selIndex != null ? describeSelectableAt(ctx.selIndex) : null);
      console.log('[CLICK→SELECT]', { via: ctx.via, target: ctx.target, hover: ctx.hoverDesc, clicked: clickedDesc, selected: selectedDesc });
      window.__lastClickCtx__ = null;
    }
  } catch(_) {}
  console.log('[FULL-DEBUG] Updated state.index from', oldIndex, 'to', state.index);
  // Always update XML color and re-render so OSMD paints selection reliably
  console.log('[FULL-DEBUG] Calling applySelectionColor...');
  applySelectionColor({ scroll });
  console.log('[FULL-DEBUG] applySelectionColor completed');
  
  // Log scroll position AFTER selection
  const scrollAfter = {
    top: els.stageWrapper.scrollTop,
    left: els.stageWrapper.scrollLeft
  };
  console.log('[SCROLL-DEBUG] Scroll position AFTER:', scrollAfter);
  
  const scrollChanged = scrollBefore.top !== scrollAfter.top || scrollBefore.left !== scrollAfter.left;
  console.log('[SCROLL-DEBUG] Scroll changed:', scrollChanged);
  if (scrollChanged) {
    console.log('[SCROLL-DEBUG] ⚠️ SCROLL DETECTED! Delta:', {
      top: scrollAfter.top - scrollBefore.top,
      left: scrollAfter.left - scrollBefore.left
    });
  }
  console.log('[SCROLL-DEBUG] === SELECTION END ===');
  
  saveSelectionIndex();
  // Play sound feedback for the clicked note
  if (shouldPlaySound) {
    playCurrentNoteSound();
  }
  try { focusStage(); } catch(_) {}
}

function moveSelection(delta) {
  const newIdx = state.index + delta;
  if (newIdx < 0 || newIdx >= state.selectable.length) return; // no wrap
  state.index = newIdx;
  applySelectionColor({ scroll: true });
  saveSelectionIndex();
  // Play sound feedback for the newly selected note
  playCurrentNoteSound();
}

function getScrollContainer() {
  // Prefer the score wrapper if it actually scrolls; otherwise use the page
  const el = els.stageWrapper;
  const wrapperScrolls = el && (
    el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth
  );
  return wrapperScrolls ? el : (document.scrollingElement || document.documentElement);
}

function captureViewportAnchorBySelection() {
  // Find your currently-selected note element (adapt the selector to your app)
  const selected = els.stage.querySelector(`[data-sel-index="${state.index}"]`);
  const container = getScrollContainer();

  const beforeRect = selected ? selected.getBoundingClientRect() : null;
  const beforeTop  = beforeRect ? beforeRect.top  : null;
  const beforeLeft = beforeRect ? beforeRect.left : null;
  const prevTop    = container.scrollTop;
  const prevLeft   = container.scrollLeft;

  // Return a function we'll call after render
  return function restore() {
    requestAnimationFrame(() => {
      const after = els.stage.querySelector(`[data-sel-index="${state.index}"]`);
      const afterRect = after ? after.getBoundingClientRect() : null;

      if (beforeTop != null && afterRect) {
        // Keep the selected note in the same screen spot
        container.scrollTop  += (afterRect.top  - beforeTop);
        container.scrollLeft += (afterRect.left - beforeLeft);
      } else {
        // Fallback: at least restore previous scrollbars
        container.scrollTop  = prevTop;
        container.scrollLeft = prevLeft;
      }
    });
  };
}

// A new, simpler function for updating the score after an edit.
async function updateAndRenderScore() {
  if (!state.osmd) {
    // If there's no OSMD instance, do a full initial render.
    console.log('No OSMD instance found, performing full initial render.');
    return renderCurrent();
  }

  setStatus('Updating...');

  // NEW: capture an anchor around the selected note
  const restoreViewport = captureViewportAnchorBySelection();

  try {
    // 2. Load the updated XML into the EXISTING OSMD instance.
    await state.osmd.load(state.xmlString);
    // 3. Tell OSMD to re-render. This is much safer than deleting the HTML yourself.
    await state.osmd.render();

    // 4. After rendering, all the old SVG elements are gone, so we must re-bind all our click handlers.
    rebindAllClickMappings();

  } catch (error) {
    console.error('An error occurred during score update, falling back to full render:', error);
    // If anything goes wrong, fall back to the original full render.
    return renderCurrent();
  } finally {
    // NEW: restore view so nothing jumps
    restoreViewport();
    setStatus('');
    focusStage();
  }
}

// Corrected version using the new update function
function editCurrent(deltaSemitones, preferSharps) {
  const sel = state.selectable[state.index];
  if (!sel || sel.type === 'rest') return; // rests not editable
  
  // Lock scroll during arrow key editing
  lockScoreScroll();
  
  // Get the measure number before making changes
  const measureEl = sel.domNodes[0]?.closest('measure');
  const measureNumber = measureEl?.getAttribute('number');
  
  // Apply delta to all notes in the tie chain
  for (const noteEl of sel.domNodes) {
    const midi = noteXmlToMidi(noteEl);
    if (midi == null) continue;
    let newMidi = clampMidi(midi + deltaSemitones);
    setNotePitchXml(noteEl, newMidi, preferSharps);
  }
  
  // Recompute accidentals with proper key-aware logic
  recomputeAccidentalsFromPitch(state.parsed);
  
  // Update xmlString and selectively re-render only the affected measure
  enforceFourPerSystem(state.parsed, 4);
  state.xmlString = serializeXml(state.parsed);
  
  // Save game progress if in game mode
  if (state.gameMode.enabled) {
    state.gameMode.gameXmlString = state.xmlString;
  }
  
  // *** THE FIX: Call our new, reliable update function. ***
  updateAndRenderScore().then(() => {
    // Re-apply the CSS highlight to the newly rendered notes
    applySelectionColor({ scroll: false });
    // Play sound feedback for the edited note
    playCurrentNoteSound();
    
    // Unlock scroll after editing is complete
    unlockScoreScroll();
  });
}

function onKeyDown(e) {
  // Ensure stage is focused and prevent default scrolling
  const key = e.key;
  const meta = e.metaKey; // CMD on mac
  
  // Always prevent default for navigation keys and space to avoid page scrolling
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(key)) {
    e.preventDefault();
    e.stopPropagation();
  }

  if (key === 'ArrowLeft') return moveSelection(-1);
  if (key === 'ArrowRight') return moveSelection(1);
  if (key === 'ArrowUp') {
    if (meta) return editCurrent(12, true); // octave up, prefer sharps
    return editCurrent(1, true); // semitone up
  }
  if (key === 'ArrowDown') {
    if (meta) return editCurrent(-12, false); // octave down, prefer flats
    return editCurrent(-1, false); // semitone down
  }
  if (key === ' ' || key === 'Space') {
    // Ensure focus stays on stage to prevent page scrolling
    focusStage();
    return playReferenceAudio();
  }
  if (key === 'M' || key === 'm') {
    // Toggle MIDI playback
    e.preventDefault();
    e.stopPropagation();
    focusStage();
    const pm = state.osmd && state.osmd.PlaybackManager;
    let isPlaying = !!state.audio.midiPlaying;
    try {
      if (pm && typeof pm.isPlaying === 'boolean') {
        isPlaying = pm.isPlaying;
      }
    } catch (_) {}
    
    if (isPlaying) {
      if (hasOSMDPlayback()) pauseWithOSMD(); else pauseMidiPlayback();
    } else {
      if (hasOSMDPlayback()) playWithOSMD(); else playScore();
    }
    return;
  }
}

function initReferenceAudio() {
  if (!state.audio.referenceAudio) {
    // Fallback built-in example if user hasn't uploaded
    state.audio.referenceAudio = new Audio('Audio/Perhaps.mp3');
    state.audio.referenceAudio.preload = 'auto';
    
    // Add event listeners for state changes
    state.audio.referenceAudio.addEventListener('ended', () => {
      setStatus('Reference audio finished');
      updateReferenceButtons();
    });
    
    state.audio.referenceAudio.addEventListener('pause', () => {
      updateReferenceButtons();
    });
    
    state.audio.referenceAudio.addEventListener('play', () => {
      state.audio.referenceAudio.addEventListener('play', () => { try { window._installRefEndFadeWatcher && window._installRefEndFadeWatcher(); } catch(_){}});
      state.audio.referenceAudio.addEventListener('loadedmetadata', () => { try { window._installRefEndFadeWatcher && window._installRefEndFadeWatcher(); } catch(_){}});
      state.audio.referenceAudio.addEventListener('pause', () => { try { window._clearRefEndFadeWatcher && window._clearRefEndFadeWatcher(); } catch(_){}});
      state.audio.referenceAudio.addEventListener('ended', () => { try { window._clearRefEndFadeWatcher && window._clearRefEndFadeWatcher(); } catch(_){}});

      updateReferenceButtons();
    });
    
    console.info('Reference audio initialized: Audio/Perhaps.mp3');
  }
}

function playReferenceAudio() {
  // Stop MIDI playback if it's playing
  if (state.audio.midiPlaying) {
    stopMidiPlayback();
  }
  // Refresh current note MIDIs for game mode
  refreshCurrentNoteMidisForGame();
  initReferenceAudio();
  const audio = state.audio.referenceAudio;
  
  // Apply speed control to reference audio
  audio.playbackRate = state.speed;
  
  // Apply gamification constraints if enabled
  if (state.gameMode.gamify.enabled) {
    constrainReferenceAudioToCheckpoint();
  }
  
  // If MIDI transport was used before, ensure it doesn't hold the old playhead
  try {
    if (state.audio.midiPlaying || state.audio.midiPaused) {
      stopMidiPlayback();
    }
  } catch(_) {}
  
  if (audio.paused) {
    // Seek to the selected note if we have a timeMap
    try {
      if (state.parsed && state.align && state.align.timeMap && state.align.timeMap.length) {
        const bpm = getTempoBpm(state.parsed);
        const { visualTimes, visualIdx } = getStartFromSelection(bpm);
        const scoreSec = (visualTimes && visualTimes[visualIdx] != null) ? visualTimes[visualIdx] : 0;
        const tm = state.align.timeMap;
        // Binary search by scoreSec
        let lo = 0, hi = tm.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (tm[mid].scoreSec < scoreSec) lo = mid + 1; else hi = mid;
        }
        const i = Math.max(1, lo);
        const p0 = tm[i - 1], p1 = tm[i] || p0;
        const denom = Math.max(1e-6, p1.scoreSec - p0.scoreSec);
        const r = (scoreSec - p0.scoreSec) / denom;
        let target = p0.audioSec + r * (p1.audioSec - p0.audioSec);
        // Clamp within audio duration
        const dur = Number.isFinite(audio.duration) ? audio.duration : null;
        if (dur && dur > 0) target = Math.max(0, Math.min(target, Math.max(0, dur - 0.05)));
        // Apply a small preroll so the first note isn't clipped by decoder seek
        const preRoll = 0.03; // 30ms (reduced to avoid late cursor perception)
        const seekTime = Math.max(0, target - preRoll);
        if (Number.isFinite(seekTime) && seekTime >= 0) {
          audio.currentTime = seekTime;
          // Remember where the true start should be so the cursor doesn't advance early
          state.align.startAudioSec = target;
          state.align.startVisualIdx = visualIdx;
        }
      }
    } catch (_) { /* non-fatal: just start from currentTime */ }

    audio.play().then(() => {
      try { if (state.align && state.align.timeMap && state.align.timeMap.length) startExternalCursorFollow(); } catch(_) {}

      console.info('Reference audio playing');
      setStatus('Playing reference audio');
      updateReferenceButtons();
    }).catch(e => {
      console.error('Failed to play reference audio:', e);
      setStatus('Failed to play reference audio', true);
    });
  } else {
    audio.pause();
    console.info('Reference audio paused');
    setStatus('Reference audio paused');
    updateReferenceButtons();
  }
}

function pauseReferenceAudio() {
  if (state.audio.referenceAudio && !state.audio.referenceAudio.paused) {
    state.audio.referenceAudio.pause();
    console.info('Reference audio paused');
    setStatus('Reference audio paused');
    updateReferenceButtons();
  }
}

function updateReferenceButtons() {
  const audio = state.audio.referenceAudio;
  const hasAudio = !!audio;
  const isPlaying = hasAudio && !audio.paused;
  if (els.refToggleBtn) {
    els.refToggleBtn.disabled = !hasAudio;
    els.refToggleBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
  }
  if (els.syncBtn) els.syncBtn.disabled = !hasAudio || !state.parsed;
}

function updateAllButtons() {
  // Update MIDI buttons
  updateMidiButtons();
  // Update reference buttons
  updateReferenceButtons();
}

async function exportCurrent() {
  if (!state.xmlString) return;
  
  // Determine what to export based on current mode
  let exportXml = state.xmlString;
  let filenameSuffix = '';
  
  if (state.gameMode.enabled) {
    // Export current game state
    exportXml = state.xmlString;
    filenameSuffix = '_game';
  } else {
    // Export normal score
    exportXml = state.xmlString;
    filenameSuffix = '';
  }
  
  const filename = 'edited_score' + filenameSuffix + '.' + (state.originalIsMXL ? 'mxl' : 'xml');
  
  if (state.originalIsMXL && state.zip) {
    // Update the main score file in the zip
    const zipCopy = state.zip.clone();
    zipCopy.file(state.xmlPathInZip, exportXml);
    const blob = await zipCopy.generateAsync({ type: 'blob' });
    saveAs(blob, filename);
  } else {
    // Plain XML export
    const blob = new Blob([exportXml], { type: 'application/xml' });
    saveAs(blob, filename);
  }
}

async function exportFile() {
  try {
    setStatus('Exporting...');
    // Remove selection coloring from export
    const doc = parseXml(state.xmlString);
    const colored = Array.from(doc.querySelectorAll('note[color], note notehead[color]'));
    for (const el of colored) el.removeAttribute('color');
    const outXml = serializeXml(doc);
    
    // Update the current xmlString with cleaned version for export
    const originalXml = state.xmlString;
    state.xmlString = outXml;
    
    await exportCurrent();
    
    // Restore original xmlString
    state.xmlString = originalXml;
    
    setStatus('Exported successfully.');
  } catch (e) {
    console.error(e);
    showError('Export failed.');
  }
}

function showError(message) {
  setStatus(message, true);
}

function hideCreditsFromSvg() {
  // Hide any composer/arranger credit texts in the rendered SVG without altering MusicXML
  const svg = els.stage.querySelector('svg');
  if (!svg) return;
  const texts = svg.querySelectorAll('text');
  texts.forEach(t => {
    const s = (t.textContent || '').trim().toLowerCase();
    if (!s) return;
    if (s === 'piano' || s.includes('composer') || s.includes('arranger') || s.startsWith('arr.') || s.includes('arr:') || s.includes('arr ')) {
      t.style.display = 'none';
    }
  });
}

function buildHeadMapAndBindClicks() {
  // Bind clicks per measure to avoid global off-by-one mismatches
  const measures = getAllMeasureSvgs();
  measures.forEach((measureSvg, idx) => {
    const measureIndex = idx; // NodeList order assumed equals display order
    const staves = getStaveNoteGroups(measureSvg);
    staves.forEach((grp, localIdx) => {
      grp.style.cursor = 'pointer';
      // Precompute global index for this local note
      let mappedIndex = -1;
      let seenInMeasure = -1;
      for (let j = 0; j < state.selectable.length; j++) {
        const it = state.selectable[j];
        if (it.measureIndex !== measureIndex) continue;
        if (it.type === 'note') {
          seenInMeasure++;
          if (seenInMeasure === localIdx) { mappedIndex = j; break; }
        }
      }
      if (mappedIndex >= 0) grp.setAttribute('data-sel-index', String(mappedIndex));
      grp.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (mappedIndex >= 0) setSelectionAndShow(mappedIndex, { scroll: false });
      }, { passive: false });
      
      // Add mousedown listener for drag functionality
      grp.addEventListener('mousedown', (ev) => {
        if (ev.button === 0) { // Left mouse button only
          startMouseDragPitchEdit(ev, grp);
        }
      }, { passive: false });
    });
    // Also map rests within this measure for completeness
    const restGroups = Array.from(measureSvg.querySelectorAll('g.vf-rest, g.rest, g[class*="rest"]'));
    restGroups.forEach((grp, localRestIdx) => {
      grp.style.cursor = 'pointer';
      let seenRest = -1;
      let mappedIndex = -1;
      for (let j = 0; j < state.selectable.length; j++) {
        const it = state.selectable[j];
        if (it.measureIndex !== measureIndex) continue;
        if (it.type === 'rest') {
          seenRest++;
          if (seenRest === localRestIdx) { mappedIndex = j; break; }
        }
      }
      if (mappedIndex >= 0) grp.setAttribute('data-sel-index', String(mappedIndex));
      grp.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (mappedIndex >= 0) setSelectionAndShow(mappedIndex, { scroll: false });
      }, { passive: false });
    });
  });
}

// Map from data-xml-node-index (int) -> selection index (int)
function buildXmlToSelIndexMap() {
  try {
    const visual = getVisualPositions(state.parsed);
    const nodes = visual.nodes || [];
    // Build reverse map: MusicXML node -> selectable index
    const nodeToSel = new Map();
    for (let selIdx = 0; selIdx < state.selectable.length; selIdx++) {
      const sel = state.selectable[selIdx];
      const list = Array.isArray(sel?.domNodes) ? sel.domNodes : [];
      for (const n of list) nodeToSel.set(n, selIdx);
    }
    // Now map visual index -> selectable index
    const xmlToSel = new Map();
    nodes.forEach((n, i) => {
      const selIdx = nodeToSel.get(n);
      if (selIdx != null) xmlToSel.set(i, selIdx);
    });
    state.xmlToSelIndex = xmlToSel;
    console.log('[map-debug] xml→sel map size:', xmlToSel.size);
  } catch (e) {
    console.warn('buildXmlToSelIndexMap failed:', e);
  }
}

// --- DEBUG HELPERS ---
function _accFromAlter(a){ return a===2?'x':a===1?'#':a===-1?'b':a===-2?'bb':''; }
function _pitchStr(xml){
  try {
    const isRest = !!xml.querySelector?.('rest');
    if (isRest) return 'rest';
    const step = xml.querySelector?.('pitch>step')?.textContent ?? '?';
    const alter = parseInt(xml.querySelector?.('pitch>alter')?.textContent ?? '0', 10) || 0;
    const oct = xml.querySelector?.('pitch>octave')?.textContent ?? '?';
    return `${step}${_accFromAlter(alter)}${oct}`;
  } catch { return 'unknown'; }
}
function _num(el, sel){ try { const t = el.querySelector?.(sel)?.textContent; return t ? Number(t) : undefined; } catch { return undefined; } }
function describeSelectableAt(index){
  const it = state.selectable?.[index];
  if (!it) return `⛔ invalid #${index}`;
  const xml = it.domNodes?.[0];
  if (!xml) return `#${index} (no xml)`;
  const type = it.type;
  const pitch = _pitchStr(xml);
  const voice = _num(xml, 'voice') ?? it.voiceId ?? '?';
  const staff = _num(xml, 'staff') ?? '?';
  const dur   = _num(xml, 'duration') ?? '?';
  const meas  = (it.measureIndex ?? -1) + 1;
  return `#${index} m${meas} ${type}:${pitch} v${voice} s${staff} dur:${dur}`;
}
function shortTarget(el){
  const tag = (el?.tagName || '').toLowerCase();
  const id  = el?.id ? `#${el.id}` : '';
  const cls = el?.classList?.value ? `.${el.classList.value}` : '';
  return `${tag}${id}${cls}` || '(no-target)';
}
function findSelIndexFromTarget(el, stop=els.stage){
  let cur = el;
  while (cur && cur !== stop){
    if (cur.getAttribute){
      const ds = cur.getAttribute('data-sel-index');
      if (ds != null) return Number(ds);
    }
    cur = cur.parentNode;
  }
  return null;
}
// --- /DEBUG HELPERS ---

// Bind click handlers by tagging via XML mapping (additive)
function bindClickMapFromXmlIndex() {
  try {
    const svgs = Array.from(els.stage?.querySelectorAll('svg') || []);
    if (!svgs.length || !state.xmlToSelIndex) return;

    // clear old tags/handlers on all pages
    svgs.forEach(svg => {
      svg.querySelectorAll('[data-sel-index]').forEach(el => {
        try { if (el.__selClickHandler) { el.removeEventListener('click', el.__selClickHandler); el.__selClickHandler = null; } } catch(_){}
        el.removeAttribute('data-sel-index');
      });
    });

    svgs.forEach(svg => {
      svg.querySelectorAll('[data-xml-node-index]').forEach(el => {
        const xmlIdx = Number(el.getAttribute('data-xml-node-index'));
        const selIdx = state.xmlToSelIndex.get(xmlIdx);
        if (selIdx == null) return;
        if (!el.hasAttribute('data-sel-index')) el.setAttribute('data-sel-index', String(selIdx));
        if (!el.__selClickHandler) {
          const handler = (ev) => { ev.preventDefault(); ev.stopPropagation(); setSelectionAndShow(selIdx, { scroll: false }); };
          el.__selClickHandler = handler;
          el.addEventListener('click', handler, { passive: false });
        }
        
        // Add mousedown listener for drag functionality
        if (!el.__selDragHandler) {
          const dragHandler = (ev) => {
            if (ev.button === 0) { // Left mouse button only
              startMouseDragPitchEdit(ev, el);
            }
          };
          el.__selDragHandler = dragHandler;
          el.addEventListener('mousedown', dragHandler, { passive: false });
        }
      });
    });

    // Install hover logger once
    if (!els.stage.__hoverLoggerInstalled) {
      let lastHover = null;
      els.stage.addEventListener('pointermove', (e) => {
        const si = findSelIndexFromTarget(e.target);
        if (si != null && si !== lastHover){
          lastHover = si;
          window.__lastHover__ = si;
          console.log('[HOVER]', describeSelectableAt(si), 'target=', shortTarget(e.target), 'xy=', e.clientX, e.clientY);
        }
      }, true);
      els.stage.__hoverLoggerInstalled = true;
    }
  } catch (err) {
    console.warn('[clickMap] Failed to bind click map:', err);
  }
}

// Sequential glyph walker (no longer used)
function bindClickMapSequential_DO_NOT_USE() {
  try {
    const scope = els.stage || els.stageWrapper || document;
    const glyphs = Array.from(scope.querySelectorAll(
      'g.vf-stavenote, g.stavenote, g[class*="stavenote"], g.vf-staveNote, g.vf-rest, g.rest, g[class*="rest"]'
    ));
    if (!glyphs.length) return;
    glyphs.forEach(g => {
      try { if (g.__selClickHandler) g.removeEventListener('click', g.__selClickHandler); } catch(_) {}
      delete g.__selClickHandler;
      g.style.cursor = 'pointer';
    });
    let r = 0;
    const isRestGlyph = g => (g.classList.contains('vf-rest') || g.classList.contains('rest') || /rest/i.test(g.getAttribute('class') || ''));
    const isNoteGlyph = g => !isRestGlyph(g);
    for (let j = 0; j < state.selectable.length && r < glyphs.length; j++) {
      const it = state.selectable[j];
      if (!it || (it.type !== 'note' && it.type !== 'rest')) continue;
      if (it.type === 'rest') {
        while (r < glyphs.length && !isRestGlyph(glyphs[r])) r++;
        if (r >= glyphs.length) break;
        const g = glyphs[r];
        if (!g.hasAttribute('data-sel-index')) g.setAttribute('data-sel-index', String(j));
        if (!g.__selClickHandler) {
          const handler = (ev) => { ev.preventDefault(); ev.stopPropagation(); setSelectionAndShow(j, { scroll: false }); };
          g.__selClickHandler = handler;
          g.addEventListener('click', handler, { passive: false });
        }
        
        // Add mousedown listener for drag functionality
        if (!g.__selDragHandler) {
          const dragHandler = (ev) => {
            if (ev.button === 0) { // Left mouse button only
              startMouseDragPitchEdit(ev, g);
            }
          };
          g.__selDragHandler = dragHandler;
          g.addEventListener('mousedown', dragHandler, { passive: false });
        }
        r++;
      } else if (it.type === 'note') {
        const chainLen = Math.max(1, Array.isArray(it.domNodes) ? it.domNodes.length : 1);
        while (r < glyphs.length && !isNoteGlyph(glyphs[r])) r++;
        if (r >= glyphs.length) break;
        for (let k = 0; k < chainLen && (r + k) < glyphs.length; k++) {
          const gk = glyphs[r + k];
          if (!isNoteGlyph(gk)) break;
          if (!gk.hasAttribute('data-sel-index')) gk.setAttribute('data-sel-index', String(j));
          if (!gk.__selClickHandler) {
            const handler = (ev) => { ev.preventDefault(); ev.stopPropagation(); setSelectionAndShow(j, { scroll: false }); };
            gk.__selClickHandler = handler;
            gk.addEventListener('click', handler, { passive: false });
          }
          
          // Add mousedown listener for drag functionality
          if (!gk.__selDragHandler) {
            const dragHandler = (ev) => {
              if (ev.button === 0) { // Left mouse button only
                startMouseDragPitchEdit(ev, gk);
              }
            };
            gk.__selDragHandler = dragHandler;
            gk.addEventListener('mousedown', dragHandler, { passive: false });
          }
        }
        r += chainLen;
      }
    }
  } catch {}
}

// Update call sites in render/rebind flows accordingly
// ... existing code ...

// Build a robust mapping from rendered SVG glyphs to MusicXML note/rest nodes.
// This improves click hit-testing across OSMD/VexFlow class variations.
function rebuildGlyphNodeMap() {
  try {
    const scope = els.stage || els.stageWrapper || document;
    const svgs = Array.from(scope.querySelectorAll('svg'));
    if (!svgs.length || !state.parsed) return;

    // all note/rest glyph containers in visual order across ALL pages
    const allGlyphs = svgs.flatMap(svg =>
      Array.from(svg.querySelectorAll(
        'g.vf-stavenote, g.stavenote, g[class*="stavenote"], g.vf-rest, g.rest, g[class*="rest"]'
      ))
    );

    const visual = getVisualPositions(state.parsed);
    const nodes = visual.nodes || [];
    const N = Math.min(nodes.length, allGlyphs.length);
    for (let i = 0; i < N; i++) {
      allGlyphs[i].setAttribute('data-xml-node-index', String(i));
    }
  } catch (e) {
    console.warn('rebuildGlyphNodeMap failed:', e);
  }
}

// Delegated click handler that resolves the closest selectable item from the click target
function enableDelegatedClickSelection() {
  try {
    const scope = els.stage || els.stageWrapper || document;
    // Remove previous if any
    if (scope.__delegatedClickHandler) {
      ['click'].forEach(t => scope.removeEventListener(t, scope.__delegatedClickHandler, true));
      scope.__delegatedClickHandler = null;
    }

    const handler = (ev) => {
      console.log('[FULL-DEBUG] Click event received, type:', ev.type);
      if (!state.selectable || !state.selectable.length) {
        console.log('[FULL-DEBUG] No selectable items, length:', (state.selectable||[]).length);
        return;
      }
      const target = ev.target;
      if (!target) {
        console.log('[FULL-DEBUG] No event target');
        return;
      }
      const svg = (target.closest && target.closest('svg')) || null;
      if (!svg) {
        console.log('[FULL-DEBUG] Click not in SVG');
        return;
      }
      console.log('[FULL-DEBUG] Click target:', target.tagName, 'class:', target.getAttribute && target.getAttribute('class'));
      
      // Test: Can we find ANY data-sel-index?
      const gMapped = target.closest('[data-sel-index]');
      let mappedEl = gMapped || null;
      if (!mappedEl && typeof ev.composedPath === 'function') {
        try {
          const path = ev.composedPath();
          mappedEl = path.find(n => n && n.getAttribute && n.getAttribute('data-sel-index') != null) || null;
          if (mappedEl) console.log('[FULL-DEBUG] Found data-sel-index via composedPath on', mappedEl.tagName);
        } catch (_) {}
      }
      if (mappedEl && mappedEl.getAttribute) {
        const idx = parseInt(mappedEl.getAttribute('data-sel-index'), 10);
        console.log('[FULL-DEBUG] Found data-sel-index:', idx);
        if (!Number.isNaN(idx)) { 
          console.log('[FULL-DEBUG] Calling setSelectionAndShow with index:', idx);
          ev.preventDefault(); 
          ev.stopPropagation(); 
          setSelectionAndShow(Math.max(0, Math.min(state.selectable.length - 1, idx)), { scroll: false }); 
          console.log('[FULL-DEBUG] setSelectionAndShow called, new state.index:', state.index);
          return; 
        }
      } else {
        console.log('[FULL-DEBUG] No data-sel-index found on target or ancestors');
        // DEBUG: Let's see what the path's actual parent structure is
        console.log('[FULL-DEBUG] Clicked path parent chain:');
        let p = target.parentElement;
        let depth = 0;
        while (p && depth < 5) {
          console.log(`[FULL-DEBUG]   ${depth}: ${p.tagName} class="${p.getAttribute('class')}" id="${p.getAttribute('id')}" data-sel-index="${p.getAttribute('data-sel-index')}"`);
          p = p.parentElement;
          depth++;
        }
        
        // EMERGENCY FALLBACK: Find nearest note by position
        const clickX = ev.clientX;
        const clickY = ev.clientY;
        const allMapped = Array.from(document.querySelectorAll('[data-sel-index]'));
        console.log('[FULL-DEBUG] Emergency fallback: searching', allMapped.length, 'mapped elements');
        
        if (allMapped.length > 0) {
          let closest = { el: null, idx: -1, dist: Infinity };
          allMapped.forEach(el => {
            const rect = el.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const dist = Math.sqrt((clickX - centerX) ** 2 + (clickY - centerY) ** 2);
            
            if (dist < closest.dist) {
              const idx = parseInt(el.getAttribute('data-sel-index'), 10);
              if (!isNaN(idx)) {
                closest = { el, idx, dist };
              }
            }
          });
          
          if (closest.idx >= 0 && closest.dist < 60) { // Within 60px
            console.log('[FULL-DEBUG] Emergency fallback found index:', closest.idx, 'distance:', closest.dist);
            ev.preventDefault(); 
            ev.stopPropagation(); 
            setSelectionAndShow(closest.idx, { scroll: false });
            return;
          }
        }
      }

      // Try XML-node-based mapping (bubble to any ancestor with data-xml-node-index)
      const gXml = target.closest('[data-xml-node-index]');
      if (gXml && gXml.getAttribute) {
        const xmlIdx = parseInt(gXml.getAttribute('data-xml-node-index'), 10);
        if (!Number.isNaN(xmlIdx) && state.selectable.length) {
          const visual = getVisualPositions(state.parsed);
          const node = visual.nodes && visual.nodes[xmlIdx];
          if (node) {
            const found = state.selectable.findIndex(it => Array.isArray(it.domNodes) && it.domNodes.includes(node));
            if (found >= 0) { ev.preventDefault(); ev.stopPropagation(); setSelectionAndShow(found, { scroll: false }); return; }
          }
        }
      }

      // Fallback: walk up to a likely glyph group, then estimate by nearest note/rest index
      const container = target.closest('g');
      if (!container) return;

      // Last resort: determine measure by parent id and choose closest note group index by x-position
      try {
        const measureG = container.closest('g[id^="measure_"] , g[id^="measure-"]') || container.closest('g.measure');
        if (!measureG) return;
        const measureId = measureG.getAttribute('id') || '';
        let measureIndex = -1;
        const m = /measure[_-](\d+)/.exec(measureId);
        if (m) measureIndex = Math.max(0, parseInt(m[1], 10) - 1);
        if (measureIndex < 0) return;

        // Collect stavenotes within the measure and pick the one with minimal x distance to click
        let staves = Array.from(measureG.querySelectorAll('g.vf-stavenote, g.stavenote, g[class*="stavenote"], g.vf-staveNote'));
        // If none detected, broaden to groups containing a notehead-like element
        if (!staves.length) {
          staves = Array.from(measureG.querySelectorAll('g'))
            .filter(g => /notehead|stavenote|staveNote/i.test(g.getAttribute('class') || '') || g.querySelector('g[class*="notehead"], g.vf-notehead, path'));
        }
        const pt = (ev.clientX != null) ? { x: ev.clientX, y: ev.clientY } : null;
        let best = { idx: 0, dist: Infinity };
        if (staves.length) {
          staves.forEach((grp, i) => {
            const bb = grp.getBoundingClientRect();
            const cx = bb.left + bb.width / 2;
            const dx = pt ? Math.abs(pt.x - cx) : i;
            if (dx < best.dist) best = { idx: i, dist: dx };
          });
        } else {
          // Absolute fallback: estimate index from measure bounds and note count
          const mbb = measureG.getBoundingClientRect();
          const notesInMeasure = state.selectable.filter(it => it.measureIndex === measureIndex && it.type === 'note');
          const n = Math.max(1, notesInMeasure.length);
          const x = pt ? pt.x : (mbb.left + mbb.width / 2);
          const r = Math.min(1, Math.max(0, (x - mbb.left) / Math.max(1, mbb.width)));
          best.idx = Math.round(r * (n - 1));
          best.dist = 0;
        }

        // Map local index to global selectable index
        let seenInMeasure = -1;
        for (let j = 0; j < state.selectable.length; j++) {
          const it = state.selectable[j];
          if (it.measureIndex !== measureIndex) continue;
          if (it.type === 'note') {
            seenInMeasure++;
            if (seenInMeasure === best.idx) {
              ev.preventDefault();
              ev.stopPropagation();
              setSelectionAndShow(j, { scroll: false });
              break;
            }
          }
        }
      } catch (_) {}

      // Final fallback: pick the nearest mapped glyph to the click point across the whole score
      try {
        const x = ev.clientX, y = ev.clientY;
        const all = Array.from(document.querySelectorAll('#stage [data-sel-index]'));
        if (all.length) {
          let best = { el: null, idx: -1, d2: Infinity };
          for (const g of all) {
            const rect = g.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = x - cx, dy = y - cy;
            const d2 = dx*dx + dy*dy;
            if (d2 < best.d2) {
              const si = parseInt(g.getAttribute('data-sel-index'), 10);
              if (!Number.isNaN(si)) best = { el: g, idx: si, d2 };
            }
          }
          if (best.idx >= 0) {
            ev.preventDefault(); ev.stopPropagation();
            setSelectionAndShow(best.idx, { scroll: false });
            return;
          }
        }
      } catch (_) {}
    };

    ['click'].forEach(t => scope.addEventListener(t, handler, true));
    scope.__delegatedClickHandler = handler;
    console.info('[click-debug] delegated click selection enabled on', scope === els.stage ? '#stage' : (scope === els.stageWrapper ? '#stageWrapper' : 'document'));
  } catch (e) {
    console.warn('enableDelegatedClickSelection failed:', e);
  }
}

// Install a global capture click logger to see where clicks are going and what's on top.
function installGlobalClickDebug() {
  try {
    const scope = document;
    if (scope.__globalClickDebugHandler) return;
    const handler = (ev) => {
      try {
        const t = ev.target;
        const tag = t && t.tagName;
        const cls = t && t.getAttribute && t.getAttribute('class');
        const inSvg = !!(t && t.closest && t.closest('svg'));
        const pe = t && window.getComputedStyle(t).pointerEvents;
        console.log('[click-debug] global', ev.type, 'target=', tag, 'class=', cls, 'inSvg=', inSvg, 'pointerEvents=', pe);
      } catch(_) {}
    };
    ['pointerdown','mousedown','click'].forEach(type => document.addEventListener(type, handler, true));
    scope.__globalClickDebugHandler = handler;
  } catch (e) {
    console.warn('installGlobalClickDebug failed:', e);
  }
}

// Install a test harness to programmatically hit-test clicks over the SVG and verify selection mapping.
function installSvgHitHandler() {
  try {
    const scope = els.stage || document;
    const svgs = scope.querySelectorAll('svg');
    svgs.forEach(svg => {
      if (svg.__hitHandlerInstalled) return;
      svg.__hitHandlerInstalled = true;
      svg.addEventListener('click', (e) => {
        try {
          // Report raw target and nearest mapped indices
          const t = e.target;
          const tag = t && t.tagName;
          const cls = t && t.getAttribute && t.getAttribute('class');
          const gMapped = t.closest && t.closest('[data-sel-index]');
          const idx = gMapped ? parseInt(gMapped.getAttribute('data-sel-index'), 10) : null;
          if (!Number.isNaN(idx) && idx != null) {
            console.log('[test] svg hit mapped selIndex=', idx, 'tag=', tag, 'class=', cls);
          } else {
          // nearest neighbor report
          const rect = t.getBoundingClientRect();
          const x = (e.clientX ?? (rect.left + rect.width/2));
          const y = (e.clientY ?? (rect.top + rect.height/2));
          const all = Array.from(document.querySelectorAll('#stage [data-sel-index]'));
          let best = { idx: -1, d2: Infinity };
          for (const g of all) {
            const r = g.getBoundingClientRect();
            const cx = r.left + r.width/2, cy = r.top + r.height/2;
            const dx = x - cx, dy = y - cy; const d2 = dx*dx + dy*dy;
            if (d2 < best.d2) {
              const si = parseInt(g.getAttribute('data-sel-index'), 10);
              if (!Number.isNaN(si)) best = { idx: si, d2 };
            }
          }
          console.log('[test] svg hit nearest selIndex=', best.idx, 'tag=', tag, 'class=', cls);
        }
        const gXml = t.closest && t.closest('[data-xml-node-index]');
        const xIdx = gXml ? parseInt(gXml.getAttribute('data-xml-node-index'), 10) : null;
        console.log('[test] svg click target tag=', tag, 'class=', cls, 'selIndex=', idx, 'xmlIndex=', xIdx);
        } catch (e) {
          console.warn('[test] svg hit handler error:', e);
        }
      });
    });
  } catch (e) {
    console.warn('installSvgHitHandler failed:', e);
  }
}

// Ensure hover scaling applies to entire beamed group by toggling a shared CSS class on the beam cluster's parent group
function installBeamHoverSync() {
  // Disabled: do not apply any hover behavior when hovering beams
  try {
    const scope = els.stage || document;
    const svgs = scope.querySelectorAll('svg');
    svgs.forEach(svg => {
      if (svg.__beamHoverInstalled) return;
      svg.__beamHoverInstalled = true;
    });
  } catch (e) {
    console.warn('installBeamHoverSync failed:', e);
  }
}

// Ensure hover scaling applies to note stems by toggling the same hover-scale class on notes that share the nearest beam; fall back to single note when un-beamed
function installStemHoverSync() {
  try {
    const scope = els.stage || document;
    const svgs = scope.querySelectorAll('svg');
    svgs.forEach(svg => {
      if (svg.__stemHoverInstalled) return;
      svg.__stemHoverInstalled = true;
      const stemSelector = 'g.vf-stem, g.stem, g[class*="stem"], path[class*="stem"], rect[class*="stem"]';
      const beamSelector = 'g.vf-beam, g.beam, g[class*="beam"]';

      const pickMeasure = (el) => el.closest && (el.closest('g[id^="measure_"], g[id^="measure-"], g.measure') || svg);

      const notesUnderBeam = (beam) => {
        const measure = pickMeasure(beam);
        const beamRect = beam.getBoundingClientRect();
        const candidates = Array.from(measure.querySelectorAll('g.vf-stavenote, g.stavenote, g[class*="stavenote"], g.vf-staveNote'));
        const within = [];
        for (const g of candidates) {
          const r = g.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          if (cx < beamRect.left - 2 || cx > beamRect.right + 2) continue; // horizontal membership
          const dy = Math.max(beamRect.top - r.bottom, r.top - beamRect.bottom, 0);
          if (dy < 24) within.push(g); // vertically close to the beam
        }
        return within;
      };

      svg.addEventListener('mouseover', (e) => {
        const stem = e.target.closest && e.target.closest(stemSelector);
        if (!stem) return;
        const measure = pickMeasure(stem);
        const stemRect = stem.getBoundingClientRect();
        // Find nearest beam in same measure by minimal vertical distance and good horizontal overlap
        const beams = Array.from(measure.querySelectorAll(beamSelector));
        let best = null;
        for (const b of beams) {
          const br = b.getBoundingClientRect();
          const overlapX = Math.min(stemRect.right, br.right) - Math.max(stemRect.left, br.left);
          if (overlapX <= 0) continue;
          const dy = Math.max(br.top - stemRect.bottom, stemRect.top - br.bottom, 0);
          const score = dy + Math.max(0, 20 - overlapX); // prefer close vertically and decent horizontal overlap
          if (!best || score < best.score) best = { beam: b, score };
        }
        let list = [];
        if (best && best.beam) {
          list = notesUnderBeam(best.beam);
        } else {
          // fallback to single note group
          const noteGroup = stem.closest && stem.closest('g.vf-stavenote, g.stavenote, g[class*="stavenote"], g.vf-staveNote');
          if (noteGroup) list = [noteGroup];
        }
        list.forEach(g => { try { g.classList.add('hover-scale'); } catch(_) {} });
        stem.__hoverNotes = list;
      }, true);

      svg.addEventListener('mouseout', (e) => {
        const stem = e.target.closest && e.target.closest(stemSelector);
        if (!stem) return;
        const list = stem.__hoverNotes || [];
        list.forEach(g => { try { g.classList.remove('hover-scale'); } catch(_) {} });
        stem.__hoverNotes = [];
      }, true);

      svg.__stemHoverInstalled = true;
    });
  } catch (e) {
    console.warn('installStemHoverSync failed:', e);
  }
}

// Public test API to simulate clicks on mapped glyphs by selectable index.
window.__osmdTest = window.__osmdTest || {};
window.__osmdTest.clickSelectableIndex = function(i) {
  try {
    const g = document.querySelector(`#stage [data-sel-index="${i}"]`);
    if (!g) { console.warn('[test] no glyph for selectable index', i); return false; }
    const bb = g.getBoundingClientRect();
    const x = bb.left + bb.width / 2;
    const y = bb.top + bb.height / 2;
    const el = document.elementFromPoint(x, y) || g;
    console.log('[test] clicking index', i, 'element=', el && el.tagName);
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return true;
  } catch (e) {
    console.warn('[test] clickSelectableIndex failed:', e);
    return false;
  }
};

// Public test API to verify glyph mapping sizes and log a sample mapping table.
window.__osmdTest.dumpMapping = function() {
  const mapped = document.querySelectorAll('#stage [data-sel-index]');
  const xmlMapped = document.querySelectorAll('#stage [data-xml-node-index]');
  console.log('[test] mapped glyphs:', mapped.length, 'xmlMapped:', xmlMapped.length, 'selectable:', (state.selectable||[]).length);
  const sample = Array.from(mapped).slice(0, 10).map(el => el.getAttribute('data-sel-index'));
  console.log('[test] first mapped indices:', sample);
};

// Sweep through first N selectable indices and assert selection & coloring
window.__osmdTest.runClickSweep = async function(n = 20, delayMs = 150) {
  const total = Math.min(n, (state.selectable || []).length);
  const results = [];
  for (let i = 0; i < total; i++) {
    const dispatched = window.__osmdTest.clickSelectableIndex(i);
    await new Promise(r => setTimeout(r, delayMs));
    const selectedIdx = state.index;
    const gSel = document.querySelector(`#stage [data-sel-index="${selectedIdx}"]`);
    let colored = false;
    if (gSel) {
      const path = gSel.querySelector('path');
      const style = path && path.getAttribute('style');
      colored = !!(style && style.includes('#16a34a'));
    }
    const pass = dispatched && selectedIdx === i;
    console.log('[test-sweep]', { i, dispatched, selectedIdx, colored, pass });
    results.push({ i, dispatched, selectedIdx, colored, pass });
  }
  try { console.table(results); } catch(_) { console.log(results); }
  return results;
};

function getMeasureSvg(zeroBasedIndex) {
  const candidates = [
    `g#measure_${zeroBasedIndex + 1}`,
    `g#measure-${zeroBasedIndex + 1}`,
  ];
  for (const sel of candidates) {
    const el = els.stage.querySelector(sel);
    if (el) return el;
  }
  // fallback: by order
  const all = getAllMeasureSvgs();
  return all[zeroBasedIndex] || null;
}

function getAllMeasureSvgs() {
  // OSMD renders into the wrapper; not necessarily inside #stage
  const scope = els.stage || els.stageWrapper || document;
  const list = Array.from(scope.querySelectorAll('g[id^="measure_"], g[id^="measure-"]'));
  if (list.length) return list;
  // final fallback by class name
  return Array.from(scope.querySelectorAll('g.measure'));
}

function getStaveNoteGroups(scopeEl) {
  const candidates = Array.from(scopeEl.querySelectorAll(
    'g.vf-stavenote, g.stavenote, g[class*="stavenote"], g.vf-staveNote'
  ));
  return candidates.filter(g => !g.classList.contains('vf-rest') && !g.classList.contains('rest'));
}

// ---------- Playback ----------
function getTempoBpm(doc) {
  // Look for tempo marking in first measure
  const tempoEl = doc.querySelector('measure metronome');
  if (tempoEl) {
    const bpmEl = tempoEl.querySelector('per-minute');
    if (bpmEl) return parseInt(bpmEl.textContent || '120', 10) || 120;
  }
  return 120; // default
}

// --- Pitch <-> MIDI helpers (MusicXML) ---
function midiFromStepAlterOct(step, alter, oct) {
  const base = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 }[step] ?? 0;
  return (oct + 1) * 12 + base + (alter || 0);
}

function readMidiFromNoteEl(noteEl) {
  // rest?
  if (noteEl.querySelector('rest')) return null;
  const step = noteEl.querySelector('pitch > step')?.textContent || 'C';
  const alter = parseInt(noteEl.querySelector('pitch > alter')?.textContent || '0', 10) || 0;
  const oct = parseInt(noteEl.querySelector('pitch > octave')?.textContent || '4', 10) || 4;
  return midiFromStepAlterOct(step, alter, oct);
}

// Build xmlIndex -> noteEl AND xmlIndex -> midi using the SAME visual ordering you use for clicks.
// We rely on your existing getVisualPositions(...) and the [data-xml-node-index] mapping.
function indexXmlNodesAndMidis(doc) {
  const map = new Map(); // xmlIndex -> midi (null for rest)
  const visual = getVisualPositions(doc); // your existing utility
  const nodes = visual?.nodes || [];      // same order used by rebuildGlyphNodeMap()

  for (let i = 0; i < nodes.length; i++) {
    const xmlNode = nodes[i]; // this is the underlying XML <note> or rest node
    // Some builds store node.el; if not, xmlNode is already the Element
    const el = xmlNode?.el || xmlNode;
    if (!el || !el.tagName) continue;
    if (el.tagName.toLowerCase() !== 'note') { map.set(i, null); continue; }
    map.set(i, readMidiFromNoteEl(el));
  }
  return map;
}

// Turn every <note> pitch to G4 (MIDI 67). We don't touch durations, ties, stems, etc.
function setAllNotesToG4(doc) {
  doc.querySelectorAll('note').forEach(note => {
    if (note.querySelector('rest')) return;
    let pitch = note.querySelector('pitch');
    if (!pitch) {
      pitch = doc.createElement('pitch');
      note.insertBefore(pitch, note.firstChild);
    }
    let stepEl = pitch.querySelector('step');   if (!stepEl) { stepEl = doc.createElement('step'); pitch.appendChild(stepEl); }
    let alterEl = pitch.querySelector('alter'); if (!alterEl) { alterEl = doc.createElement('alter'); pitch.appendChild(alterEl); }
    let octEl = pitch.querySelector('octave');  if (!octEl) { octEl = doc.createElement('octave'); pitch.appendChild(octEl); }

    stepEl.textContent = 'G';
    alterEl.textContent = '0';
    octEl.textContent = '4';
  });
}


// Enter Game Mode
async function enterGameMode() {
  if (state.gameMode.enabled) return;
  state.gameMode.enabled = true;

  // snapshot original XML and pitches if not already saved
  if (!state.gameMode.originalXmlString) {
    state.gameMode.originalXmlString = state.xmlString;          // current full score
    state.gameMode.originalNoteMidiByXmlIndex = indexXmlNodesAndMidis(state.parsed);
  }

  // Check if we have saved game progress
  if (state.gameMode.gameXmlString) {
    // Restore previous game state
    state.parsed = parseXml(state.gameMode.gameXmlString);
    state.xmlString = state.gameMode.gameXmlString;
  } else {
    // First time entering game mode - set all notes to G4
    setAllNotesToG4(state.parsed);
    // IMPORTANT: do NOT change anything else (ties, durations, etc.)
    state.xmlString = serializeXml(state.parsed);
    state.gameMode.gameXmlString = state.xmlString; // save initial game state
  }

  // rebuild selectable array from game XML
  state.selectable = buildSelectable(state.parsed);

  // re-render
  await renderCurrent();                 // your existing renderer
  rebuildGlyphNodeMap();                 // ensure [data-xml-node-index] on all pages
  
  // restore selection color and functionality
  await applySelectionColor({ scroll: true });
  
  // Update button text
  updateGameModeButton();
  
  // Initialize gamification if enabled
  enterGamificationMode();
}

// Exit Game Mode
async function exitGameMode() {
  if (!state.gameMode.enabled) return;

  // Save current game progress before exiting
  state.gameMode.gameXmlString = state.xmlString;

  // restore original XML
  state.parsed = parseXml(state.gameMode.originalXmlString);
  state.xmlString = state.gameMode.originalXmlString;

  state.gameMode.enabled = false;

  // rebuild selectable array from restored XML
  state.selectable = buildSelectable(state.parsed);

  // re-render clean score
  await renderCurrent();
  
  // restore selection color and functionality
  await applySelectionColor({ scroll: true });
  
  // Update button text
  updateGameModeButton();
  
  // Exit gamification mode
  exitGamificationMode();
}

// Refresh current note MIDIs for game mode
function refreshCurrentNoteMidisForGame() {
  state.gameMode.currentNoteMidiByXmlIndex = indexXmlNodesAndMidis(state.parsed);
}

// Update Game Mode toggle state based on current state
function updateGameModeButton() {
  const toggle = document.getElementById('btnGameMode');
  if (toggle) {
    toggle.checked = state.gameMode.enabled;
  }
}

// Game mode cursor advance handler
function gameModeOnCursorAdvance(newCursorIndex) {
  if (!state.gameMode.enabled) return;
  
  // Store previous cursor index for gamification scoring
  const oldCursorIndex = state.audio.previousCursorIndex;
  state.audio.previousCursorIndex = newCursorIndex;
  
  // Call gamification scoring hook
  onCursorAdvance(newCursorIndex, oldCursorIndex);
}

function applySwingTiming(events, divisions, swingRatio = 0.67) {
  // Apply swing rhythm to eighth notes and smaller subdivisions
  // swingRatio: 0.5 = straight, 0.67 = medium swing, 0.75 = heavy swing
  const swingEvents = [];
  const eighthNoteDivisions = divisions / 2; // eighth note duration in divisions
  
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    // Handle tied notes with multiple attack points
    if (event.tieAttacks && event.tieAttacks.length > 1) {
      // For tied notes, apply swing to the start time but keep as single sustaining note
      // Find the earliest attack that would be affected by swing
      let swingOffset = 0;
      
      // Check if any of the tie attacks fall on off-beats that need swing
      for (const attackDiv of event.tieAttacks) {
        const beatPosition = attackDiv % divisions;
        const isOffBeat = beatPosition === eighthNoteDivisions;
        
        if (isOffBeat) {
          const quarterNoteDuration = divisions;
          const swingFirstDuration = quarterNoteDuration * swingRatio;
          const swingSecondStart = swingFirstDuration;
          const normalSecondStart = eighthNoteDivisions;
          const calculatedOffset = swingSecondStart - normalSecondStart;
          
          // Apply swing offset to the start time if this is the first attack
          if (attackDiv === event.startDiv) {
            swingOffset = calculatedOffset;
          }
          break; // Only apply swing to the first off-beat attack
        }
      }
      
      // Create single tied note event with swing-adjusted start time
      swingEvents.push({
        ...event,
        startDiv: event.startDiv + swingOffset,
        tieAttacks: undefined // Remove to avoid confusion
      });
    } else {
      // Regular note or single tied note
      const nextEvent = events[i + 1];
      
      // Check if this is an eighth note or smaller
      if (event.durationDiv <= eighthNoteDivisions) {
        // Find the beat position within a quarter note
        const beatPosition = event.startDiv % divisions;
        const isOnBeat = beatPosition === 0;
        const isOffBeat = beatPosition === eighthNoteDivisions;
        
        let swingOffset = 0;
        
        if (isOnBeat && nextEvent && 
            nextEvent.startDiv === event.startDiv + eighthNoteDivisions &&
            nextEvent.durationDiv <= eighthNoteDivisions) {
          // This is the first of a pair of eighth notes - extend it
          swingOffset = 0; // First note starts on time
        } else if (isOffBeat) {
          // This is the second of a pair of eighth notes - delay it
          const quarterNoteDuration = divisions;
          const swingFirstDuration = quarterNoteDuration * swingRatio;
          const swingSecondStart = swingFirstDuration;
          const normalSecondStart = eighthNoteDivisions;
          swingOffset = swingSecondStart - normalSecondStart;
        }
        
        swingEvents.push({
          ...event,
          startDiv: event.startDiv + swingOffset
        });
      } else {
        // Quarter notes and longer - no swing applied
        swingEvents.push(event);
      }
    }
  }
  
  return swingEvents;
}

function getPlaybackEvents(doc) {
  const events = [];
  const parts = Array.from(doc.querySelectorAll('score-partwise > part, score-timewise > part, part'));
  const part = parts[0];
  if (!part) return { events, divisions: 1 };

  const measures = Array.from(part.querySelectorAll('measure'));
  let divisions = 1;
  let timeCursor = 0; // in divisions
  const tiedNotes = new Map(); // midi -> { startDiv, totalDuration, attacks: [] }

  for (const measure of measures) {
    const divEl = measure.querySelector('attributes > divisions');
    if (divEl) divisions = parseInt(divEl.textContent || '1', 10) || divisions;

    const notesAndRests = Array.from(measure.querySelectorAll('note'));

    for (const n of notesAndRests) {
      const isGrace = !!n.querySelector('grace');
      if (isGrace) continue;

      const dur = parseInt(n.querySelector('duration')?.textContent || '0', 10);
      const isRest = !!n.querySelector('rest');

      if (isRest) {
        events.push({ startDiv: timeCursor, durationDiv: dur, isRest: true });
      } else {
        const midi = noteXmlToMidi(n);
        if (midi === null) {
          timeCursor += dur; // Account for duration of unplayable notes
          continue;
        }

        const tieStart = !!n.querySelector('tie[type="start"]');
        const tieStop = !!n.querySelector('tie[type="stop"]');

        if (tieStop && !tieStart) {
          if (tiedNotes.has(midi)) {
            const tiedNote = tiedNotes.get(midi);
            tiedNote.totalDuration += dur;
            tiedNote.attacks.push(timeCursor); // Add this attack point
            // Create event for the complete tied note with all attack points
            events.push({ 
              startDiv: tiedNote.startDiv, 
              durationDiv: tiedNote.totalDuration, 
              midi, 
              isRest: false,
              tieAttacks: tiedNote.attacks // Include all attack points for swing timing
            });
            tiedNotes.delete(midi);
          }
        } else if (tieStart) {
          if (!tiedNotes.has(midi)) {
            tiedNotes.set(midi, { startDiv: timeCursor, totalDuration: dur, attacks: [timeCursor] });
          } else {
            const tiedNote = tiedNotes.get(midi);
            tiedNote.totalDuration += dur;
            tiedNote.attacks.push(timeCursor); // Add this attack point
          }
        } else {
          events.push({ startDiv: timeCursor, durationDiv: dur, midi, isRest: false });
        }
      }
      timeCursor += dur;
    }
  }

  // Add any notes that started a tie but never ended it
  for (const [midi, tiedNote] of tiedNotes) {
    events.push({ 
      startDiv: tiedNote.startDiv, 
      durationDiv: tiedNote.totalDuration, 
      midi, 
      isRest: false 
    });
  }
  
  // Sort events by start time to ensure correct order after processing ties
  events.sort((a, b) => a.startDiv - b.startDiv);

  return { events, divisions };
}

// Variant used for MIDI playback: re-articulate on every printed notehead,
// even across ties, so swing off-beats still receive an attack.
function getPlaybackEventsPerNote(doc) {
  const events = [];
  const parts = Array.from(doc.querySelectorAll('score-partwise > part, score-timewise > part, part'));
  const part = parts[0];
  if (!part) return { events, divisions: 1 };

  const measures = Array.from(part.querySelectorAll('measure'));
  let divisions = 1;
  let timeCursor = 0; // in divisions

  for (const measure of measures) {
    const divEl = measure.querySelector('attributes > divisions');
    if (divEl) divisions = parseInt(divEl.textContent || '1', 10) || divisions;

    const notes = Array.from(measure.querySelectorAll('note'));
    for (const n of notes) {
      const isGrace = !!n.querySelector('grace');
      if (isGrace) continue;
      const dur = parseInt(n.querySelector('duration')?.textContent || '0', 10);
      const isRest = !!n.querySelector('rest');
      if (isRest) {
        events.push({ startDiv: timeCursor, durationDiv: dur, isRest: true });
      } else {
        const midi = noteXmlToMidi(n);
        if (midi != null) {
          events.push({ startDiv: timeCursor, durationDiv: dur, midi, isRest: false });
        }
      }
      timeCursor += dur;
    }
  }

  return { events, divisions };
}

// Build a visual positions list that includes every printed note/rest position,
// including ties (continuations), so the cursor advances per glyph, not per merged audio event.
function getVisualPositions(doc) {
  const positions = [];
  const nodes = [];
  const parts = Array.from(doc.querySelectorAll('score-partwise > part, score-timewise > part, part'));
  const part = parts[0];
  if (!part) return { positions, nodes, divisions: 1 };
  const measures = Array.from(part.querySelectorAll('measure'));
  let divisions = 1;
  let timeCursor = 0; // in divisions
  for (const measure of measures) {
    const divEl = measure.querySelector('attributes > divisions');
    if (divEl) divisions = parseInt(divEl.textContent || '1', 10) || divisions;
    const notesAndRests = Array.from(measure.querySelectorAll('note'));
    for (const n of notesAndRests) {
      const isGrace = !!n.querySelector('grace');
      if (isGrace) continue;
      const dur = parseInt(n.querySelector('duration')?.textContent || '0', 10);
      // Each printed note or rest advances the cursor visually
      positions.push(timeCursor);
      nodes.push(n);
      timeCursor += dur;
    }
  }
  return { positions, nodes, divisions };
}

// Apply swing offsets to raw start positions to keep visual cursor aligned with swung audio
function applySwingOffsetsToPositions(positions, divisions, swingRatio = 0.67) {
  const out = [];
  const eighth = divisions / 2;
  for (let i = 0; i < positions.length; i++) {
    const startDiv = positions[i];
    const beatPos = startDiv % divisions;
    const isOn = beatPos === 0;
    const isOff = beatPos === eighth;
    let offset = 0;
    if (isOn) {
      // first of pair stays
      offset = 0;
    } else if (isOff) {
      const swingFirst = divisions * swingRatio;
      const swingSecondStart = swingFirst;
      const normalSecondStart = eighth;
      offset = swingSecondStart - normalSecondStart;
    }
    out.push(startDiv + offset);
  }
  return out;
}

// Start or restart the time-based cursor sync loop using stored visualTimes.
// Safe to call on initial play and on resume. No-op if OSMD native playback is available.
function startCursorSync(visualTimes) {
  try {
    if (!state.osmd || state.osmd.PlaybackManager) return;
    const vt = visualTimes || state.audio.visualTimes;
    if (!vt || !vt.length) return;

    // Cancel any existing loop to avoid duplicates
    if (state.audio.playheadAnimationId) {
      cancelAnimationFrame(state.audio.playheadAnimationId);
      state.audio.playheadAnimationId = null;
    }

    function binarySearchTarget(timeSec) {
      let lo = 0, hi = vt.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (vt[mid] <= timeSec) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    }

    function syncCursorToTime() {
      if (!state.audio.midiPlaying) return; // stop updating when paused/stopped
      const curTime = window.Tone ? window.Tone.Transport.seconds : 0;
      const target = binarySearchTarget(curTime);
      let currentIdx = state.audio.cursorIndex || 0;
      if (target !== currentIdx) {
        const step = target - currentIdx;
        try {
          if (step > 0) {
            for (let i = 0; i < step; i++) state.osmd.cursor.next();
          } else {
            // If going backwards, reset and fast-forward
            state.osmd.cursor.reset();
            for (let i = 0; i < target; i++) state.osmd.cursor.next();
          }
          state.audio.cursorIndex = target;
          // Game mode hook
          gameModeOnCursorAdvance(target);
        } catch (_) {}
      }
      state.audio.playheadAnimationId = requestAnimationFrame(syncCursorToTime);
    }

    // Kick off the loop
    state.audio.playheadAnimationId = requestAnimationFrame(syncCursorToTime);
  } catch (e) {
    console.warn('startCursorSync failed:', e);
  }
}



async function ensurePiano() {
  if (state.audio.piano) return state.audio.piano;
  if (state.audio.isLoading) {
    // Wait for the loading to complete instead of returning null
    while (state.audio.isLoading) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return state.audio.piano;
  }
  state.audio.isLoading = true;
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  state.audio.ctx = ac;
  try {
    if (!window.Tone) throw new Error('Tone.js not loaded. Check index.html');
    
    // Ensure Tone.js context is started first
    if (window.Tone.context.state !== 'running') {
      await window.Tone.start();
      // Small delay to ensure context is fully initialized
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    const tonePiano = await createTonePiano();
    if (ac.state === 'suspended') { 
      await ac.resume(); 
    }
    state.audio.piano = tonePiano;
    state.audio.engine = 'tone';
  } catch (e) {
    // Fallback: simple WebAudio synth so playback still works
    console.warn('Piano init failed, using enhanced synth fallback:', e.message);
    if (ac.state === 'suspended') { 
      try { await ac.resume(); } catch (_) {} 
    }
    state.audio.piano = createEnhancedPianoFallback(ac);
    state.audio.engine = 'fallback';
  } finally {
    state.audio.isLoading = false;
  }
  return state.audio.piano;
}



async function playScore() {
  try {
    if (state.audio.midiPlaying) return; // already playing
    
    // Stop reference audio if it's playing
    if (state.audio.referenceAudio && !state.audio.referenceAudio.paused) {
      pauseReferenceAudio();
    }

    // --- Standard playback setup from the beginning ---
    state.audio.midiPlaying = true;
    state.audio.midiPaused = false;
    state.audio.scheduledNotes = [];
    updateMidiButtons();

    // Ensure audio context is running
    if (window.Tone) {
      if (window.Tone.context.state !== 'running') {
        console.log('Starting Tone.js audio context...');
        await window.Tone.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('Audio context state:', window.Tone.context.state);
      }
    } else {
      throw new Error('Tone.js not loaded');
    }

    const piano = await ensurePiano();
    if (!piano) throw new Error('Piano initialization failed.');

    // Use merged ties for natural sustain (do not re-articulate tied notes)
    const { events, divisions } = getPlaybackEvents(state.parsed);
    if (!events.length) {
      console.info('No playable note events found.');
      setStatus('Nothing to play in the current score.');
      stopMidiPlayback(); // Reset state
      return;
    }

    const swingEvents = applySwingTiming(events, divisions, state.swing);
    const bpm = getTempoBpm(state.parsed);
    const adjustedBpm = bpm * state.speed;
    const secPerDiv = (60 / adjustedBpm) / divisions;
    
    // Filter events for current checkpoint if gamification is enabled
    const filteredEvents = filterEventsForCheckpoint(swingEvents, divisions, adjustedBpm);

    console.info(`Scheduling ${filteredEvents.length} events at ${adjustedBpm} BPM (${Math.round(state.speed * 100)}% speed) using Tone.js Transport.`);
    setStatus('Playing MIDI audio');

    // Use Tone.Transport for pausable scheduling with speed control
    window.Tone.Transport.bpm.value = adjustedBpm;
    window.Tone.Transport.cancel(); // Clear previous events

    // --- Schedule notes and cursor updates using Tone.Transport ---
    window.Tone.Transport.bpm.value = adjustedBpm;
    window.Tone.Transport.cancel(); // Clear previous events

    const baseGain = 0.8 * (state.audio.masterGain ?? 0.8);
    // --- Final Cursor-Based Note Coloring (no custom playhead) ---
    state.osmd.cursor.reset();
    // Show OSMD cursor without custom line styling
    state.osmd.cursor.show();
    // No manual styling — rely on OSMD defaults or native PlaybackManager visuals

    // Clear any existing custom playhead events (legacy)
    if (state.audio.playheadRepeatId) {
      window.Tone.Transport.clear(state.audio.playheadRepeatId);
      state.audio.playheadRepeatId = null;
    }

    // Check if OSMD has built-in PlaybackManager for native playhead
    if (state.osmd.PlaybackManager) {
      console.log('Using OSMD native PlaybackManager for playhead');
      
      // Use OSMD's built-in playback system
      try {
        // Configure OSMD's playback settings with speed control
        state.osmd.PlaybackManager.setBpm(adjustedBpm);
        
        // Start OSMD's native playback (handles its own cursor/playhead)
        state.osmd.PlaybackManager.play();
        
        console.log('OSMD native playback started');
      } catch (e) {
        console.warn('OSMD PlaybackManager failed; continuing without custom playhead:', e);
      }
    } else {
      console.log('OSMD PlaybackManager not available; no custom playhead line will be shown');
    }

    filteredEvents.forEach((ev, index) => {
      const time = ev.startDiv * secPerDiv;
      const duration = (ev.durationDiv || 0) * secPerDiv;

      window.Tone.Transport.scheduleOnce(t => {

        if (!ev.isRest) {
          // 1) Play audio no matter what; cursor visuals are optional
          if (typeof ev.midi === 'number') {
            piano.play(ev.midi, t, { gain: baseGain });
          }

          // 2) Try to color, but don't block audio if cursor isn't ready
          const notes = (state.osmd?.cursor?.NotesUnderCursor?.() || []);
          if (notes.length > 0) {
            const originalColors = notes.map(n => n.sourceNote?.NoteheadColor);
            state.audio.lastColoredNotes = notes; // For pausing

            // Directly color the SVG element (guard against missing vfnote)
            notes.forEach(n => {
              const vf = n && n.vfnote && n.vfnote[0];
              if (vf && typeof vf.getSVGElement === 'function') {
                const el = vf.getSVGElement();
                if (el) el.style.fill = 'red';
              }
            });

            // Schedule un-coloring
            window.Tone.Transport.scheduleOnce(() => {
              notes.forEach((n, i) => {
                const vf = n && n.vfnote && n.vfnote[0];
                if (vf && typeof vf.getSVGElement === 'function') {
                  const el = vf.getSVGElement();
                  if (el) el.style.fill = originalColors[i] || 'black';
                }
              });
            }, t + duration * 0.9);
          }
        }
      }, time);
    });

    // Schedule the final stop
    const lastEventTime = filteredEvents.length > 0 ? 
      Math.max(...filteredEvents.map(ev => ev.startDiv * secPerDiv)) :
      0;
    state.audio.duration = lastEventTime + 2; // Store duration for playhead

    window.Tone.Transport.scheduleOnce(() => {
      stopMidiPlayback();
    }, state.audio.duration);

    // --- Prepare visual timeline and start from a *playable* attack time ---
    const { visualTimes, visualIdx } = getStartFromSelection(adjustedBpm);

    // Time requested by the clicked visual glyph (could be a tie continuation)
    const requestedSec = visualTimes[Math.min(visualIdx, visualTimes.length - 1)] || 0;

    // Build the list of actual MIDI attack times (after swing)
    const attackSecs = filteredEvents
      .filter(ev => !ev.isRest)
      .map(ev => ev.startDiv * secPerDiv);

    // Find the last attack at or before the requested time (binary search floor)
    let lo = 0, hi = attackSecs.length - 1, floorIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (attackSecs[mid] <= requestedSec) { floorIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    const offsetSec = attackSecs[floorIdx] ?? 0;

    // Move the OSMD cursor to the glyph nearest to the actual attack time
    state.osmd.cursor.reset();
    let cursorIdx = 0;
    // If there are swing-adjusted visual times, anchor to the attack time
    for (; cursorIdx < visualTimes.length - 1 && visualTimes[cursorIdx + 1] <= offsetSec; cursorIdx++) {
      state.osmd.cursor.next();
    }

    if (!state.osmd.PlaybackManager) {
      state.audio.visualTimes = visualTimes;
      state.audio.cursorIndex = cursorIdx;
      startCursorSync(visualTimes);
    }

    // Apply gamification constraints if enabled
    if (state.gameMode.gamify.enabled) {
      constrainMidiTransportToCheckpoint();
    }
    
    // Start Tone transport at a true attack so a NoteOn will fire immediately
    window.Tone.Transport.start(undefined, Math.max(0, offsetSec - 0.001));

  } catch (e) {
    console.error('Playback failed:', e);
    showError('Playback failed.');
    stopMidiPlayback(); // Ensure state is reset on failure
  }
}

function pauseMidiPlayback() {
  if (!state.audio.midiPlaying) return;

  // Stop smooth playhead animation
  if (state.audio.playheadAnimationId) {
    cancelAnimationFrame(state.audio.playheadAnimationId);
    state.audio.playheadAnimationId = null;
  }

  // Stop all currently sounding notes
  if (state.audio.piano) {
    // For both Tone.js and fallback, this should release all active notes
    if (typeof state.audio.piano.releaseAll === 'function') {
      state.audio.piano.releaseAll();
    }
  }
  // Cancel any future scheduled events with Tone.js Transport
  if (window.Tone && state.audio.engine === 'tone') {
    window.Tone.Transport.pause();
  }

  state.audio.midiPlaying = false;
  state.audio.midiPaused = true;
  updateMidiButtons();
  console.info('MIDI playback paused');
  setStatus('MIDI audio paused');
  // On pause, keep playhead where it is; reset any colored notes to black
  if (state.osmd && state.audio.lastColoredNotes) {
    state.audio.lastColoredNotes.forEach(n => {
        if (n.vfnote && n.vfnote[0]) {
            const el = n.vfnote[0].getSVGElement();
            if (el) el.style.fill = 'black';
        }
    });
    state.audio.lastColoredNotes = [];
  }
}



function stopMidiPlayback() {
  state.audio.midiPlaying = false;
  state.audio.midiPaused = false;
  state.audio.scheduledNotes = [];
  state.audio.visualTimes = null;
  state.audio.cursorIndex = 0;
  setStatus('MIDI audio stopped');

  // Stop smooth playhead animation
  if (state.audio.playheadAnimationId) {
    cancelAnimationFrame(state.audio.playheadAnimationId);
    state.audio.playheadAnimationId = null;
  }

  // On stop, reset cursor (hide playhead) and any colored notes
  if (state.osmd) {
    state.osmd.cursor.reset();
    state.osmd.cursor.hide();
    
    // Reset any transform applied to the cursor
    const playhead = state.osmd.cursor.cursorElement;
    if (playhead && playhead.style) {
      playhead.style.transform = '';
    }
    
    if (state.audio.playheadRepeatId) {
      window.Tone.Transport.clear(state.audio.playheadRepeatId);
      state.audio.playheadRepeatId = null;
    }
    if (state.audio.lastColoredNotes) {
        state.audio.lastColoredNotes.forEach(n => {
            if (n.vfnote && n.vfnote[0]) {
                const el = n.vfnote[0].getSVGElement();
                if (el) el.style.fill = 'black';
            }
        });
        state.audio.lastColoredNotes = [];
    }
  }

  if (state.audio.piano) {
    if (typeof state.audio.piano.releaseAll === 'function') {
      state.audio.piano.releaseAll();
    }
  }
  if (window.Tone && state.audio.engine === 'tone') {
    window.Tone.Transport.stop();
    window.Tone.Transport.cancel();
  }
  
  updateMidiButtons();
  console.info('MIDI playback stopped');
}

function updateMidiButtons() {
  // If OSMD PlaybackManager is available, prefer its state if we can read it
  const pm = state.osmd && state.osmd.PlaybackManager;
  let isPlaying = !!state.audio.midiPlaying;
  try {
    if (pm && typeof pm.isPlaying === 'boolean') {
      isPlaying = pm.isPlaying;
    }
  } catch (_) {}
  if (els.midiToggleBtn) {
    els.midiToggleBtn.disabled = !state.parsed;
    els.midiToggleBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
    els.midiToggleBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
  }
}

// ---------- Tone.js integration ----------

async function createTonePiano() {
  // Use Salamander grand piano samples hosted by Tone.js project
  const Tone = window.Tone;
  const sampler = new Tone.Sampler({
    urls: {
      'A0': 'A0.mp3', 'C1': 'C1.mp3', 'D#1': 'Ds1.mp3',
      'F#1': 'Fs1.mp3', 'A1': 'A1.mp3', 'C2': 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3', 'A2': 'A2.mp3', 'C3': 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3', 'A3': 'A3.mp3', 'C4': 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3', 'A4': 'A4.mp3', 'C5': 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3', 'A5': 'A5.mp3', 'C6': 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3', 'A6': 'A6.mp3', 'C7': 'C7.mp3', 'D#7': 'Ds7.mp3', 'F#7': 'Fs7.mp3', 'A7': 'A7.mp3', 'C8': 'C8.mp3',
    },
    release: 0.2, // Much shorter release for drier sound
    baseUrl: './assets/salamander/',
  });
  
  // Connect directly to destination without any reverb effects
  sampler.connect(Tone.Destination);
  
  // Set comfortable default volume
  sampler.volume.value = -3; // Slightly louder since we removed reverb
  console.info('Loading local Salamander piano samples...');
  await sampler.loaded;
  
  // Additional wait to ensure all buffers are truly ready
  // This addresses the "buffer is either not set or not loaded" error
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Test that samples are actually playable before declaring ready
  let retries = 0;
  while (retries < 5) {
    try {
      // Test a middle C note to ensure buffers are loaded
      const testNote = window.Tone.Frequency(60, 'midi').toNote();
      // Just test that we can create the note name without error
      if (testNote) break;
    } catch (e) {
      console.warn(`Sample readiness test failed, retry ${retries + 1}/5:`, e.message);
      await new Promise(resolve => setTimeout(resolve, 100));
      retries++;
    }
  }
  
  console.info('Piano samples loaded and ready.');
  // Adapter to our piano.play(midi, when, opts) interface
  const play = (midi, when, opts = {}) => {
    const Tone = window.Tone;
    
    // Since we already awaited sampler.loaded above, the sampler should be ready
    // Remove the incorrect readiness check that was causing notes to be skipped
    
    const now = Tone.now();
    // when is in AudioContext time; map to Tone time if using Tone engine
    let t = now;
    if (typeof when === 'number') {
      if (state.audio.engine === 'tone') {
        t = when; // already using Tone.now() for scheduling
      } else if (state.audio.ctx) {
        const offset = Math.max(0, when - state.audio.ctx.currentTime);
        t = now + offset;
      }
    }
    const vel = Math.min(1, Math.max(0, opts.gain ?? 0.25));
    
    try {
      // Use note name string so Sampler can map to the closest loaded buffer reliably
      const noteName = Tone.Frequency(midi, 'midi').toNote();
      
      // Additional check: if we get a "buffer not loaded" error, wait and retry once
      try {
        const vol = vel * (state.audio.masterGain ?? 0.8);
        sampler.triggerAttackRelease(noteName, 0.3, t, vol); // Shorter duration for drier sound
      } catch (bufferError) {
        if (bufferError.message && bufferError.message.includes('buffer')) {
          console.warn(`Buffer not ready for note ${midi}, attempting retry...`);
          // Wait a bit and try once more
          setTimeout(() => {
            try {
              const vol2 = vel * (state.audio.masterGain ?? 0.8);
              sampler.triggerAttackRelease(noteName, 0.3, Tone.now(), vol2); // Shorter duration for drier sound
            } catch (retryError) {
              console.error('Retry failed for note:', midi, retryError);
            }
          }, 50);
        } else {
          throw bufferError; // Re-throw if it's not a buffer issue
        }
      }
    } catch (error) {
      console.error('Error playing note:', midi, error);
    }
  };
  return { __isTone: true, play };
}



/* =======================
   AUDIO/ SCORE ALIGN HELPERS
   ======================= */

// Build score chroma (12 bins) from parsed MusicXML lead notes
async function buildScoreChroma(hopSec = 0.046) {
  const bpm = getTempoBpm(state.parsed);
  const { events, divisions } = getPlaybackEvents(state.parsed);
  const secPerDiv = (60 / bpm) / divisions;
  const notes = events
    .filter(e => !e.isRest && typeof e.midi === 'number')
    .map(e => ({
      midi: e.midi,
      startSec: e.startDiv * secPerDiv,
      endSec: (e.startDiv + e.durationDiv) * secPerDiv
    }));
  const totalSec = notes.length ? Math.max(...notes.map(n => n.endSec)) : 0;
  const T = Math.max(1, Math.ceil(totalSec / hopSec));
  const X = Array.from({ length: T }, () => new Float32Array(12).fill(0));
  for (const n of notes) {
    const pc = n.midi % 12;
    const a = Math.floor(n.startSec / hopSec);
    const b = Math.max(a, Math.ceil(n.endSec / hopSec));
    for (let t = a; t <= b && t < T; t++) X[t][pc] += 1;
  }
  for (let t = 0; t < T; t++) {
    let s = 0; for (let i = 0; i < 12; i++) s += X[t][i] * X[t][i];
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < 12; i++) X[t][i] /= s;
  }
  return { chroma: X, hopSec };
}

// Resample to mono using OfflineAudioContext
async function resampleBuffer(buf, targetSr) {
  if (buf.sampleRate === targetSr && buf.numberOfChannels === 1) return buf;
  const length = Math.floor(buf.duration * targetSr);
  const ctx = new OfflineAudioContext(1, length, targetSr);
  const src = ctx.createBufferSource();
  // downmix to mono
  const mono = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const ch0 = mono.getChannelData(0);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) ch0[i] += d[i] / buf.numberOfChannels;
  }
  src.buffer = mono;
  src.connect(ctx.destination);
  src.start(0);
  return await ctx.startRendering();
}

// Simple Goertzel-based audio chroma (12 bins summed across octaves)
async function buildAudioChroma(audioBuf, hopSec = 0.046, winSec = 0.092) {
  const targetSr = 22050;
  const buf = await resampleBuffer(audioBuf, targetSr);
  const ch = buf.getChannelData(0);
  const hop = Math.max(1, Math.floor(hopSec * targetSr));
  const win = Math.max(hop, Math.floor(winSec * targetSr));
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 * (1 - Math.cos(2*Math.PI*i/(win-1)));

  const minMidi = 48, maxMidi = 84; // C3..C6
  const midiList = []; for (let m = minMidi; m <= maxMidi; m++) midiList.push(m);
  const twoPi = 2 * Math.PI;

  function goertzel(frame, freq) {
    const w = twoPi * freq / targetSr;
    const cosw = Math.cos(w), sinw = Math.sin(w);
    let s0=0, s1=0, s2=0;
    for (let n = 0; n < frame.length; n++) {
      s0 = frame[n] + 2*cosw*s1 - s2;
      s2 = s1; s1 = s0;
    }
    const re = s1 - s2*cosw;
    const im = s2*sinw;
    return re*re + im*im;
  }

  const frames = Math.max(1, Math.floor((ch.length - win) / hop));
  const Y = Array.from({ length: frames }, () => new Float32Array(12).fill(0));
  const frame = new Float32Array(win);

  for (let f = 0, pos = 0; f < frames; f++, pos += hop) {
    for (let i = 0; i < win; i++) frame[i] = (ch[pos+i] || 0) * hann[i];
    for (let midi of midiList) {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const pwr = goertzel(frame, freq);
      Y[f][midi % 12] += pwr;
    }
    let s = 0; for (let i = 0; i < 12; i++) s += Y[f][i]*Y[f][i];
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < 12; i++) Y[f][i] /= s;
  }
  return { chroma: Y, hopSec: hop / targetSr };
}

// Subsequence DTW with cosine distance (expects L2-normalized frames)
function dtwSubsequence(X, Y, hopX, hopY) {
  const n = X.length, m = Y.length;
  const INF = 1e15;
  const D = Array.from({length: n+1}, () => new Float64Array(m+1).fill(INF));
  const P = Array.from({length: n+1}, () => new Uint8Array(m+1));
  D[0].fill(0);
  const cosDist = (a,b) => { let s=0; for (let i=0;i<12;i++) s += a[i]*b[i]; return 1 - s; };
  for (let i=1;i<=n;i++) {
    for (let j=1;j<=m;j++) {
      const c = cosDist(X[i-1], Y[j-1]);
      let best = D[i-1][j-1], dir=1;
      if (D[i-1][j] < best) { best = D[i-1][j]; dir=2; }
      if (D[i][j-1] < best) { best = D[i][j-1]; dir=3; }
      D[i][j] = c + best; P[i][j] = dir;
    }
  }
  let jStar = 1, best = D[n][1];
  for (let j=2;j<=m;j++) if (D[n][j] < best) { best = D[n][j]; jStar = j; }
  const path = [];
  let i=n, j=jStar;
  while (i>0 && j>0) {
    path.push([i-1, j-1]);
    const d = P[i][j];
    if (d===1){i--;j--;} else if (d===2){i--;} else {j--;}
  }
  path.reverse();
  return path.map(([ii,jj]) => ({ scoreSec: ii*hopX, audioSec: jj*hopY }));
}

function rotate12(frame, k) {
  const out = new Float32Array(12);
  for (let i=0;i<12;i++) out[i] = frame[(i - k + 12) % 12];
  return out;
}

function startExternalCursorFollow() {
  cancelAnimationFrame(state.align.rafId);
  const audio = state.audio.referenceAudio;
  const timeMap = state.align.timeMap || [];
  if (!audio || !timeMap.length || !state.osmd) return;

  const visual = computeVisualTimes(getTempoBpm(state.parsed));
  const visualTimes = visual.times;
  // Move OSMD cursor to the selected note so visual playhead aligns with new start
  try {
    const { visualIdx } = getStartFromSelection(getTempoBpm(state.parsed));
    state.osmd.cursor.reset();
    for (let i = 0; i < visualIdx; i++) state.osmd.cursor.next();
    state.audio.cursorIndex = visualIdx;
  } catch(_) {}
  const introEnd = timeMap[0].audioSec ?? Infinity;
  state.align.visualTimes = visualTimes;

  function mapAudioToScore(t) {
    // binary search on timeMap
    let lo = 0, hi = timeMap.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timeMap[mid].audioSec < t) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(1, lo);
    const a0 = timeMap[i-1], a1 = timeMap[i] || a0;
    const r = (t - a0.audioSec) / Math.max(1e-6, a1.audioSec - a0.audioSec);
    return a0.scoreSec + r * (a1.scoreSec - a0.scoreSec);
  }

  function seekCursorToSec(sec) {
    const times = state.align.visualTimes || visualTimes;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < sec) lo = mid + 1; else hi = mid;
    }
    const idx = Math.max(0, lo-1);
    try {
      const currentIdx = state.audio.cursorIndex || 0;
      if (idx !== currentIdx) {
        if (idx > currentIdx) {
          for (let i=currentIdx; i<idx; i++) state.osmd.cursor.next();
        } else {
          state.osmd.cursor.reset();
          for (let i=0; i<idx; i++) state.osmd.cursor.next();
        }
        state.osmd.cursor.show();
        state.audio.cursorIndex = idx;
        // Game mode hook
        gameModeOnCursorAdvance(idx);
      }
    } catch(_) {}
  }

  function tick() {
    if (audio.paused) return;
    let t = audio.currentTime;
    // Anticipate cursor slightly to counteract drawing/DOM latency
    const visualLead = 0.012; // 12ms lead
    t += visualLead;
    // If we used preroll, hold cursor until true start
    if (typeof state.align.startAudioSec === 'number') {
      if (t < state.align.startAudioSec) {
        // Keep cursor on selected note until we pass the real start
        try { state.osmd.cursor.show(); } catch(_) {}
        state.align.rafId = requestAnimationFrame(tick);
        return;
      } else {
        // Clear guard after crossing start
        delete state.align.startAudioSec;
      }
    }
    if (t < introEnd) {
      try { state.osmd.cursor.hide(); } catch(_) {}
    } else {
      seekCursorToSec(mapAudioToScore(t));
    }
    state.align.rafId = requestAnimationFrame(tick);
  }
  state.align.rafId = requestAnimationFrame(tick);
}

// Perform score↔audio synchronization
async function performSync() {
  try {
    if (!state.parsed) { setStatus('Load a score first', true); return; }
    if (!state.align.audioBuf) { setStatus('Load an audio file first', true); return; }
    if (els.syncBtn) els.syncBtn.disabled = true;
    if (els.syncStatus) els.syncStatus.textContent = 'Syncing…';
    const X = await buildScoreChroma(0.046);
    const Y = await buildAudioChroma(state.align.audioBuf, 0.046, 0.092);
    let bestMap = null, bestScore = -Infinity;
    for (let k = 0; k < 12; k++) {
      const Xk = X.chroma.map(fr => rotate12(fr, k));
      const map = dtwSubsequence(Xk, Y.chroma, X.hopSec, Y.hopSec);
      const score = map.length; // crude quality metric
      if (score > bestScore) { bestScore = score; bestMap = map; }
    }
    state.align.timeMap = bestMap;
    try { window._installRefEndFadeWatcher && window._installRefEndFadeWatcher(); } catch(_){ }
    if (els.syncStatus) els.syncStatus.textContent = 'Synced ✓';
    updateReferenceButtons();
  } catch (e) {
    console.error(e);
    setStatus('Sync failed', true);
    if (els.syncStatus) els.syncStatus.textContent = 'Sync failed';
    throw e;
  } finally {
    if (els.syncBtn) els.syncBtn.disabled = false;
  }
}

function init() {
    // Prevent UI control interactions from bubbling up and stealing focus
  const controlEls = [
    els.speedSlider, els.midiToggleBtn, els.refPlayBtn, els.refPauseBtn,
    els.audioInput, els.exportBtn, els.input, els.syncBtn
  ];
  controlEls.forEach(el => {
    if (!el) return;
    ['pointerdown','pointerup','pointermove','touchstart','touchmove','mousedown','mousemove'].forEach(type => {
      el.addEventListener(type, e => e.stopPropagation(), { capture: true });
    });
  });

els.exportBtn.addEventListener('click', exportFile);

  // Position slider bubbles initially
  const positionAllBubbles = () => {
    try {
      if (els.speedSlider && els.speedValue) {
        const sp = Math.max(1, Math.min(100, parseFloat(els.speedSlider.value || '100')));
        const r = els.speedSlider.getBoundingClientRect();
        els.speedValue.style.left = (r.width * ((sp - 1) / 99)) + 'px';
        els.speedValue.textContent = sp + '%';
      }
      if (els.volumeSlider && els.volumeValue) {
        const vp = Math.max(0, Math.min(100, parseFloat(els.volumeSlider.value || '80')));
        const r = els.volumeSlider.getBoundingClientRect();
        els.volumeValue.style.left = (r.width * (vp / 100)) + 'px';
        els.volumeValue.textContent = vp + '%';
      }
      if (els.zoomSlider && els.zoomValue) {
        const zp = Math.max(1, Math.min(100, parseFloat(els.zoomSlider.value || '100')));
        const r = els.zoomSlider.getBoundingClientRect();
        els.zoomValue.style.left = (r.width * ((zp - 1) / 99)) + 'px';
        els.zoomValue.textContent = zp + '%';
      }
    } catch(_) {}
  };
  positionAllBubbles();
  window.addEventListener('resize', positionAllBubbles);

  // Song library functionality
  const songLibrary = [
    'An Oscar For Treadwell', 'Another Hairdo', 'Anthropology', 'Au Private 1', 'Au Private 2',
    'Back Home Blues', 'Barbados', 'Billies\'s Bounce', 'Bird Gets The Worm', 'Bloomdido',
    'Blue Bird', 'Blues For Alice', 'Buzzy', 'Card Board', 'Celerity', 'Chasing The Bird',
    'Cheryl', 'Chi Chi', 'Confirmation', 'Cosmic Rays', 'Dewey Square', 'Diverse', 'Donna Lee',
    'KC Blues', 'Kim 1', 'Kim 2', 'Ko Ko', 'Laird Baird', 'Marmaduke', 'Mohawk 1', 'Mohawk 2',
    'Moose The Mooche', 'My Little Suede Shoes', 'Now\'s The Time 1', 'Now\'s The Time 2',
    'Ornithology', 'Passport', 'Perhaps', 'Red Cross', 'Relaxing With Lee', 'Scrapple From The Apple',
    'Segment', 'Shawnuff', 'Si Si', 'Steeplechase', 'The Bird', 'Thriving From A Riff', 'Visa',
    'Warming Up A Riff', 'Yardbird Suite'
  ];

  // Populate song list
  function populateSongList() {
    if (!els.songList) return;
    els.songList.innerHTML = '';
    
    songLibrary.forEach(songName => {
      const button = document.createElement('button');
      button.className = 'song-item';
      button.textContent = songName;
      button.addEventListener('click', () => loadSong(songName));
      els.songList.appendChild(button);
    });
  }

  // Load song function
  async function loadSong(songName) {
    try {
      // Update UI to show loading
      if (els.status) els.status.textContent = `Loading ${songName}...`;
      
      // Clear active state from all song items
      document.querySelectorAll('.song-item').forEach(item => {
        item.classList.remove('active');
      });
      
      // Set active state on selected song
      const selectedButton = Array.from(document.querySelectorAll('.song-item'))
        .find(btn => btn.textContent === songName);
      if (selectedButton) {
        selectedButton.classList.add('active');
      }

      // Load XML file
      const xmlPath = `./Songs/${songName}/${songName}.xml`;
      const xmlResponse = await fetch(xmlPath);
      if (!xmlResponse.ok) throw new Error(`Failed to load XML: ${xmlResponse.status}`);
      const xmlText = await xmlResponse.text();
      
      // Create a File-like object for XML
      const xmlBlob = new Blob([xmlText], { type: 'application/xml' });
      const xmlFile = new File([xmlBlob], `${songName}.xml`, { type: 'application/xml' });
      
      // Load the XML file using existing loadFile function
      await loadFile(xmlFile);
      
      // Load audio file
      const audioPath = `./Songs/${songName}/${songName}.mp3`;
      const audioResponse = await fetch(audioPath);
      if (!audioResponse.ok) throw new Error(`Failed to load audio: ${audioResponse.status}`);
      const audioBlob = await audioResponse.blob();
      
      // Create audio element
      try { if (state.audio.referenceAudio) state.audio.referenceAudio.pause(); } catch(_){ }
      const audioUrl = URL.createObjectURL(audioBlob);
      state.align.audioFile = new File([audioBlob], `${songName}.mp3`, { type: 'audio/mpeg' });
      state.align.audioUrl = audioUrl;
      state.audio.referenceAudio = new Audio(audioUrl);
      state.audio.referenceAudio.preload = 'auto';
      state.audio.referenceAudio.addEventListener('ended', updateReferenceButtons);
      state.audio.referenceAudio.addEventListener('pause', updateReferenceButtons);
      state.audio.referenceAudio.addEventListener('play', updateReferenceButtons);
      state.audio.referenceAudio.addEventListener('play', () => { try { window._installRefEndFadeWatcher && window._installRefEndFadeWatcher(); } catch(_){}});
      state.audio.referenceAudio.addEventListener('loadedmetadata', () => { try { window._installRefEndFadeWatcher && window._installRefEndFadeWatcher(); } catch(_){}});
      state.audio.referenceAudio.addEventListener('pause', () => { try { window._clearRefEndFadeWatcher && window._clearRefEndFadeWatcher(); } catch(_){}});
      state.audio.referenceAudio.addEventListener('ended', () => { try { window._clearRefEndFadeWatcher && window._clearRefEndFadeWatcher(); } catch(_){}});

      updateReferenceButtons();
      
      // Decode for analysis
      const ac = state.audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
      state.audio.ctx = ac;
      const arrayBuf = await audioBlob.arrayBuffer();
      state.align.audioBuf = await ac.decodeAudioData(arrayBuf);
      if (els.syncStatus) els.syncStatus.textContent = 'Synced ✓';
      
      // Auto-sync after both files load
      if (state.parsed) {
        if (els.syncStatus) els.syncStatus.textContent = 'Auto-syncing…';
        try {
          await performSync();
        } catch (e) {
          console.error(e);
          if (els.syncStatus) els.syncStatus.textContent = 'Auto-sync failed';
        }
      }
      
      if (els.status) els.status.textContent = '';
    } catch (error) {
      console.error('Failed to load song:', error);
      if (els.status) els.status.textContent = `Failed to load ${songName}: ${error.message}`;
    }
  }

  // Initialize song list on page load
  populateSongList();
  
  // Load default song "Perhaps"
  setTimeout(() => {
    loadSong('Perhaps');
  }, 100);



  // MIDI playback toggle control
  if (els.midiToggleBtn) {
    els.midiToggleBtn.addEventListener('click', (e) => {
      const pm = state.osmd && state.osmd.PlaybackManager;
      // Determine playing state preferring PM when available
      let isPlaying = !!state.audio.midiPlaying;
      try { if (pm && typeof pm.isPlaying === 'boolean') isPlaying = pm.isPlaying; } catch (_) {}
      if (isPlaying) {
        if (hasOSMDPlayback()) pauseWithOSMD(); else pauseMidiPlayback();
      } else {
        // Stop reference audio before starting MIDI
        if (state.audio.referenceAudio && !state.audio.referenceAudio.paused) {
          pauseReferenceAudio();
        }
        // Always start from the selected note
        if (hasOSMDPlayback()) playWithOSMD(); else playScore();
      }
      // Restore focus to the score so arrow keys work immediately
      if (e && e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur();
      // Delay to let layout settle, then focus stage
      setTimeout(() => focusStage(), 0);
    });
  }
  
  // Speed control (+ double-click reset to 100%)
  if (els.speedSlider && els.speedValue) {
    els.speedSlider.addEventListener('input', (e) => {
      state.speed = parseFloat(e.target.value) / 100.0;
      const p = (state.speed - 0.01) / (1.0 - 0.01);
      els.speedValue.textContent = Math.round(state.speed * 100) + '%';
      // Apply speed to any currently playing audio
      if (state.audio.referenceAudio) {
        state.audio.referenceAudio.playbackRate = state.speed;
      }
      // Return focus to stage after slider interaction
      setTimeout(() => focusStage(), 0);
      // If MIDI is playing, restart playback with new speed
      if (state.audio.midiPlaying && !state.audio.midiPaused) {
        const wasPlaying = true;
        pauseMidiPlayback();
        setTimeout(() => { if (wasPlaying) playScore(); }, 50);
      }
    });
  }
    
  // Swing control (50-75% range with double-click reset to 62%)
  if (els.swingSlider && els.swingValue) {
    const applySwingPercent = (percent) => {
      const clamped = Math.max(50, Math.min(75, percent));
      state.swing = clamped / 100.0;
      els.swingSlider.value = clamped; // Ensure slider position matches
      els.swingValue.textContent = clamped + '%';
      try {
        const rect = els.swingSlider.getBoundingClientRect();
        const p = (clamped - 50) / (75 - 50);
        els.swingValue.style.left = (rect.width * p) + 'px';
      } catch(_) {}
      // If MIDI is playing, restart playback with new swing
      if (state.audio.midiPlaying && !state.audio.midiPaused) {
        const wasPlaying = true;
        pauseMidiPlayback();
        setTimeout(() => { if (wasPlaying) playScore(); }, 50);
      }
    };
    // Initialize swing slider
    applySwingPercent(Math.round(state.swing * 100));
    els.swingSlider.addEventListener('input', (e) => {
      const percent = Math.max(50, Math.min(75, parseInt(e.target.value, 10)));
      applySwingPercent(percent);
      // Return focus to stage after slider interaction
      setTimeout(() => focusStage(), 0);
    });
    // Double-click to reset to default 62%
    els.swingSlider.addEventListener('dblclick', () => {
      els.swingSlider.value = '62';
      applySwingPercent(62);
    });
    // Also allow double-click on the label/value to reset
    const swingResetTargets = [els.swingValue, document.querySelector('label[for="swingSlider"]')].filter(Boolean);
    swingResetTargets.forEach(t => t.addEventListener('dblclick', () => {
      els.swingSlider.value = '62';
      applySwingPercent(62);
    }));
  }
  
  // Zoom control (match Speed slider style: 1-100%)
  if (els.zoomSlider && els.zoomValue) {
    const applyZoomPercent = async (percent) => {
      els.zoomValue.textContent = percent + '%';
      try {
        const rect = els.zoomSlider.getBoundingClientRect();
        const p = (percent - 1) / 99;
        els.zoomValue.style.left = (rect.width * p) + 'px';
      } catch(_) {}
      if (state.osmd) {
        state.osmd.Zoom = percent / 100.0;
        await state.osmd.render();
        await enforceFourPerSystemPostLayout(state.osmd, els.stage);
        rebindAllClickMappings();
      }
    };
    els.zoomSlider.addEventListener('input', async (e) => {
      const percent = Math.max(1, Math.min(100, parseInt(e.target.value, 10)));
      await applyZoomPercent(percent);
      // Return focus to stage after slider interaction
      setTimeout(() => focusStage(), 0);
    });
    // Double-click to reset to default 100%
    els.zoomSlider.addEventListener('dblclick', async () => {
      els.zoomSlider.value = '100';
      await applyZoomPercent(100);
    });
    // Also allow double-click on the label/value to reset
    const resetTargets = [els.zoomValue, document.querySelector('label[for="zoomSlider"]')].filter(Boolean);
    resetTargets.forEach(t => t.addEventListener('dblclick', async () => {
      els.zoomSlider.value = '100';
      await applyZoomPercent(100);
    }));
  }

  // Volume control (master) with double-click reset to 80%
  if (els.volumeSlider && els.volumeValue) {
    const applyVolumePercent = (percent) => {
      const clamped = Math.max(0, Math.min(100, percent));
      els.volumeValue.textContent = clamped + '%';
      try {
        const rect = els.volumeSlider.getBoundingClientRect();
        const p = clamped / 100;
        els.volumeValue.style.left = (rect.width * p) + 'px';
      } catch(_) {}
      // Reference audio volume
      try {
        if (state.audio.referenceAudio) state.audio.referenceAudio.volume = clamped / 100.0;
      } catch(_) {}
      // Tone.js master
      try {
        if (window.Tone && window.Tone.Destination) {
          // Boost MIDI volume to match reference audio levels
          // Map 0..100% to -40..+6 dB for better balance with reference audio
          const db = clamped === 0 ? -Infinity : (clamped / 100) * 6 + (1 - clamped / 100) * -40;
          window.Tone.Destination.volume.value = (clamped === 0) ? -Infinity : db;
        }
      } catch(_) {}
      // Fallback synth: scale note gain via a global multiplier
      state.audio.masterGain = clamped / 100.0;
    };
    // Initialize
    applyVolumePercent(parseInt(els.volumeSlider.value || '80', 10));
    els.volumeSlider.addEventListener('input', (e) => {
      applyVolumePercent(parseInt(e.target.value, 10));
      // Return focus to stage after slider interaction
      setTimeout(() => focusStage(), 0);
    });
    els.volumeSlider.addEventListener('dblclick', () => {
      els.volumeSlider.value = '80';
      applyVolumePercent(80);
    });
    const volResetTargets = [els.volumeValue, document.querySelector('label[for="volumeSlider"]')].filter(Boolean);
    volResetTargets.forEach(t => t.addEventListener('dblclick', () => {
      els.volumeSlider.value = '80';
      applyVolumePercent(80);
    }));
  }

  // Removed spacing and page width controls per user feedback
  
  // Reference audio controls
  if (els.refToggleBtn) {
    els.refToggleBtn.addEventListener('click', () => {
      if (state.audio.referenceAudio && !state.audio.referenceAudio.paused) {
        pauseReferenceAudio();
      } else {
        // Stop MIDI before starting reference audio
        if (state.audio.midiPlaying) {
          if (hasOSMDPlayback()) pauseWithOSMD(); else pauseMidiPlayback();
        }
        playReferenceAudio();
      }
    });
  }
  
  // Ensure MIDI play button click also triggers audio unlock if needed

  els.stageWrapper.addEventListener('keydown', onKeyDown);
  // Keep focus on the score canvas — only on explicit click
  els.stageWrapper.addEventListener('click', () => focusStage());
  focusStage();
  // Proactively unlock audio on the first user interaction so Play works on first click
  const unlock = async () => {
    try {
      if (window.Tone && window.Tone.context.state !== 'running') {
        await window.Tone.start();
        // Small delay to ensure context is fully started
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Pre-initialize piano to avoid delays on first play
      await ensurePiano();
      if (state.audio?.ctx && state.audio.ctx.state === 'suspended') {
        await state.audio.ctx.resume();
      }
      console.info('Audio unlocked and piano pre-initialized.');
    } catch (e) {
      console.warn('Audio unlock attempt failed:', e?.message || e);
    } finally {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  // Game Mode toggle wiring
  document.getElementById('btnGameMode').addEventListener('change', async (e) => {
    const on = e.currentTarget.checked;
    if (on) await enterGameMode();
    else await exitGameMode();
  });

  // Initialize all slider positions and values
  // Speed slider
  const speedP = (state.speed - 0.01) / (1.0 - 0.01);
  try { 
    els.speedValue.textContent = Math.round(state.speed * 100) + '%';
    els.speedValue.style.left = (els.speedSlider.getBoundingClientRect().width * speedP) + 'px'; 
  } catch(_) {}
  
  // Swing slider - initialize with correct value
  try {
    const swingPercent = Math.round(state.swing * 100);
    els.swingSlider.value = swingPercent;
    els.swingValue.textContent = swingPercent + '%';
    const swingP = (swingPercent - 50) / (75 - 50);
    els.swingValue.style.left = (els.swingSlider.getBoundingClientRect().width * swingP) + 'px';
  } catch(_) {}
  
  // Volume slider
  try {
    const volumePercent = parseInt(els.volumeSlider.value || '80', 10);
    els.volumeValue.textContent = volumePercent + '%';
    const volumeP = volumePercent / 100;
    els.volumeValue.style.left = (els.volumeSlider.getBoundingClientRect().width * volumeP) + 'px';
  } catch(_) {}
  
  // Zoom slider
  try {
    const zoomPercent = parseInt(els.zoomSlider.value || '100', 10);
    els.zoomValue.textContent = zoomPercent + '%';
    const zoomP = (zoomPercent - 1) / 99;
    els.zoomValue.style.left = (els.zoomSlider.getBoundingClientRect().width * zoomP) + 'px';
  } catch(_) {}

  // Auto-load Perhaps.xml if available
  fetch('MXL/Perhaps.xml')
    .then(r => r.ok ? r.blob() : Promise.reject(new Error('Perhaps.xml not found')))
    .then(blob => {
      const file = new File([blob], 'Perhaps.xml', { type: 'application/vnd.recordare.musicxml' });
      loadFile(file);
    })
    .catch(() => {
      // Fallback to Test.mxl if Perhaps.xml not found
      fetch('Test.mxl')
        .then(r => r.ok ? r.blob() : Promise.reject(new Error('Test.mxl not found')))
        .then(blob => {
          const file = new File([blob], 'Test.mxl', { type: 'application/vnd.recordare.musicxml' });
          loadFile(file);
        })
        .catch(() => {});
    });
}

window.addEventListener('DOMContentLoaded', init);

// ---------- OSMD native playback integration (conditional) ----------

function hasOSMDPlayback() {
  const pm = state.osmd && state.osmd.PlaybackManager;
  return !!(pm && (typeof pm.play === 'function' || typeof pm.playFromMs === 'function'));
}

// Some environments/styles disable pointer events on embedded SVG. Make sure they are enabled.
function ensureSvgPointerEvents() {
  try {
    const scope = els.stage || els.stageWrapper || document;
    const svgs = scope.querySelectorAll('svg');
    svgs.forEach(svg => {
      const pe = window.getComputedStyle(svg).pointerEvents;
      if (pe === 'none') {
        svg.style.pointerEvents = 'auto';
      }
      // Ensure groups and paths receive events
      svg.querySelectorAll('g, path, rect, use').forEach(el => {
        if (window.getComputedStyle(el).pointerEvents === 'none') {
          el.style.pointerEvents = 'auto';
        }
      });
      try {
        const bbox = svg.getBoundingClientRect();
        console.log('[click-debug] ensureSvgPointerEvents: svg bbox', { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height });
      } catch(_) {}
    });
  } catch (e) {
    console.warn('ensureSvgPointerEvents failed:', e);
  }
}

function playWithOSMD() {
  try {
    const pm = state.osmd && state.osmd.PlaybackManager;
    if (!pm) return;
    // Compute start offset based on selected editable note (visual glyph index)
    const bpm = getTempoBpm(state.parsed);
    const { visualTimes, visualIdx } = getStartFromSelection(bpm);
    const offsetSec = visualTimes[Math.min(visualIdx, visualTimes.length - 1)] || 0;
    const offsetMs = Math.max(0, Math.round(offsetSec * 1000));
    if (typeof pm.playFromMs === 'function') pm.playFromMs(offsetMs);
    else if (typeof pm.play === 'function') pm.play();
    // Mirror state for button updates if pm.isPlaying is not exposed
    state.audio.midiPlaying = true;
    updateMidiButtons();
    setStatus('Playing MIDI audio');
  } catch (e) {
    console.warn('OSMD PlaybackManager play failed, falling back:', e);
    playScore();
  }
}

function pauseWithOSMD() {
  try {
    const pm = state.osmd && state.osmd.PlaybackManager;
    if (!pm) return;
    if (typeof pm.pause === 'function') pm.pause();
    else if (typeof pm.stop === 'function') pm.stop();
    state.audio.midiPlaying = false;
    updateMidiButtons();
    setStatus('MIDI audio paused');
  } catch (e) {
    console.warn('OSMD PlaybackManager pause failed, falling back:', e);
    pauseMidiPlayback();
  }
}

function stopWithOSMD() {
  try {
    const pm = state.osmd && state.osmd.PlaybackManager;
    if (!pm) return;
    if (typeof pm.stop === 'function') pm.stop();
    state.audio.midiPlaying = false;
    updateMidiButtons();
    setStatus('MIDI audio stopped');
  } catch (e) {
    console.warn('OSMD PlaybackManager stop failed, falling back:', e);
    stopMidiPlayback();
  }
}

function rebindAllClickMappings() {
  try {
    hideCreditsFromSvg();
    ensureSvgPointerEvents();
    rebuildGlyphNodeMap();
    buildXmlToSelIndexMap();
    buildHeadMapAndBindClicks();
    bindClickMapFromXmlIndex();
    enableDelegatedClickSelection();
  } catch (e) {
    console.warn('[rebind] Failed to rebind click mappings:', e);
  }
}

function installStageObserverOnce() {
  if (!els || !els.stage) return;
  if (els.stage.__observerInstalled) return;
  const mo = new MutationObserver((mutations) => {
    if (mutations.some(m => m.type === 'childList')) {
      // Defer to end of microtask so OSMD finishes DOM swaps
      setTimeout(() => {
        rebindAllClickMappings();
      }, 0);
    }
  });
  mo.observe(els.stage, { childList: true, subtree: true });
  els.stage.__observerInstalled = true;
  console.log('[observer] Stage MutationObserver installed');
}



/* === Auto-fade reference audio at end of NEXT measure (fingerprint-aware) ========== */
(function(){
  function getScoreVisualTimes() {
    try {
      // Prefer cached visualTimes built during render
      if (state?.audio?.visualTimes?.times?.length) return state.audio.visualTimes;
      if (typeof computeVisualTimesSec === 'function') {
        const vt = computeVisualTimesSec();
        return vt && vt.times ? vt : { times: [] };
      }
    } catch(_) {}
    return { times: [] };
  }

  function estimateBeatsPerMeasure() {
    try {
      if (!Array.isArray(state.selectable) || !state.selectable.length) return null;
      const byMeasure = new Map();
      for (const sel of state.selectable) {
        const mi = sel?.measureIndex; if (mi == null) continue;
        const b = (typeof computeDurBeatsForSelectable === 'function') ? computeDurBeatsForSelectable(sel) : 0;
        byMeasure.set(mi, (byMeasure.get(mi) || 0) + (b || 0));
      }
      if (byMeasure.size === 0) return null;
      const hist = new Map();
      for (const [, beats] of byMeasure) {
        const rounded = Math.round((beats || 0) * 4) / 4;
        hist.set(String(rounded), (hist.get(String(rounded)) || 0) + 1);
      }
      let bestKey = null, bestCount = -1;
      for (const [k, c] of hist) if (c > bestCount) { bestCount = c; bestKey = k; }
      const typical = parseFloat(bestKey);
      return Number.isFinite(typical) && typical > 0 ? typical : null;
    } catch(_) { return null; }
  }

  // Return seconds in SCORE time for one measure
  function estimateScoreSecPerMeasure() {
    const bpm = state?.transportBPM || 120;
    const beats = estimateBeatsPerMeasure() ?? 4;
    return (60 / (bpm || 120)) * beats;
  }

  function getScoreEndScoreSec() {
    try {
      // Use msBySel (score time in ms) instead of refSecBySel (audio time)
      if (state?.timeline?.msBySel?.length) {
        const i = state.timeline.msBySel.length - 1;
        const lastStart = (state.timeline.msBySel[i] || 0) / 1000; // convert ms to seconds
        const dur = (state.timeline.metaBySel?.[i]?.duration) || 0; // score seconds
        return Math.max(0, lastStart + dur);
      }
      // Fallback: last visual time
      const vt = getScoreVisualTimes();
      if (vt.times?.length) return vt.times[vt.times.length - 1] || 0;
    } catch(_) {}
    return null;
  }

  // Map SCORE seconds -> AUDIO seconds using fingerprint map if available
  function scoreSecToAudioSec(t) {
    try {
      const tm = state?.align?.timeMap;
      if (Array.isArray(tm) && tm.length) {
        let lo = 0, hi = tm.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (tm[mid].scoreSec < t) lo = mid + 1; else hi = mid;
        }
        const i = Math.max(1, lo);
        const a0 = tm[i-1], a1 = tm[i] || a0;
        const denom = Math.max(1e-6, a1.scoreSec - a0.scoreSec);
        const r = (t - a0.scoreSec) / denom;
        return a0.audioSec + r * (a1.audioSec - a0.audioSec);
      }
    } catch(_) {}
    // No map: assume 1:1 with OSMD "score seconds"
    return t;
  }

  // Compute the audio-sec target at end of *next* measure after printed score
  function computeTargetAudioSec() {
    const baseScoreEnd = getScoreEndScoreSec();
    if (!Number.isFinite(baseScoreEnd)) return null;

    // Prefer actual next-measure beats if the next measure exists
    let beatsNext = null;
    try {
      if (Array.isArray(state.selectable) && state.selectable.length) {
        const lastIdx = state.selectable.length - 1;
        const lastMeasure = state.selectable[lastIdx]?.measureIndex;
        if (lastMeasure != null) {
          let sum = 0, any = false;
          for (const sel of state.selectable) {
            if (sel?.measureIndex === (lastMeasure + 1)) {
              const b = (typeof computeDurBeatsForSelectable === 'function') ? computeDurBeatsForSelectable(sel) : 0;
              sum += (b || 0); any = true;
            }
          }
          if (any) beatsNext = sum;
        }
      }
    } catch(_) {}

    const bpm = state?.transportBPM || 120;
    const secPerBeat = 60 / (bpm || 120);
    const extraScoreSec = (Number.isFinite(beatsNext) && beatsNext > 0)
      ? (beatsNext * secPerBeat)
      : estimateScoreSecPerMeasure();

    const targetScore = baseScoreEnd + (Number.isFinite(extraScoreSec) ? extraScoreSec : 2.0);
    return scoreSecToAudioSec(targetScore);
  }

  function clearEndFadeWatcher() {
    const a = state?.audio?.referenceAudio;
    if (!a || !state?.audio) return;
    if (state.audio._endFadeInterval) { clearInterval(state.audio._endFadeInterval); state.audio._endFadeInterval = null; }
    if (state.audio._endFadeTU) { try { a.removeEventListener('timeupdate', state.audio._endFadeTU); } catch(_){}; state.audio._endFadeTU = null; }
    state.audio._isEndFading = false;
    state.audio._preFadeVolume = undefined;
  }

  function installReferenceEndFadeWatcher() {
    const a = state?.audio?.referenceAudio;
    if (!a) return;
    clearEndFadeWatcher();

    const FADE_MS = 600;          // 0.6s fade
    const START_AHEAD_SEC = 0.50; // begin fade 0.5s before target
    const SAFETY_SEC = 0.12;      // clamp after

    let cachedTarget = null;
    const onTU = () => {
      try {
        if (!Number.isFinite(cachedTarget)) cachedTarget = computeTargetAudioSec();
        // Try again if alignment/timeline arrives late
        if (!Number.isFinite(cachedTarget)) return;

        const dur = Number.isFinite(a.duration) ? a.duration : Infinity;
        const endSec = Math.min(cachedTarget, Math.max(0, dur - 0.05));

        if (!state.audio._isEndFading && a.currentTime >= (endSec - START_AHEAD_SEC)) {
          state.audio._isEndFading = true;
          state.audio._preFadeVolume = a.volume;
          let steps = Math.max(8, Math.round(FADE_MS / 40));
          const dt = FADE_MS / steps;
          let i = 0;
          state.audio._endFadeInterval = setInterval(() => {
            i++;
            const left = Math.max(0, 1 - i / steps);
            try { a.volume = (state.audio._preFadeVolume ?? 1) * left; } catch(_){}
            if (i >= steps) {
              clearInterval(state.audio._endFadeInterval);
              state.audio._endFadeInterval = null;
              try { a.pause(); a.currentTime = endSec; } catch(_){}
              try { a.volume = (state.audio._preFadeVolume ?? 1); } catch(_){}
              state.audio._isEndFading = false;
            }
          }, dt);
        }
        if (a.currentTime >= (endSec + SAFETY_SEC)) {
          try { a.pause(); } catch(_){}
        }
      } catch(_) {}
    };

    state.audio._endFadeTU = onTU;
    a.addEventListener('timeupdate', onTU);
  }

  // Expose
  window._installRefEndFadeWatcher = installReferenceEndFadeWatcher;
  window._clearRefEndFadeWatcher = clearEndFadeWatcher;
})();
/* === /Auto-fade ================================================================ */



/* === Auto-fade reference audio (next-measure) === */
(function() {
  function getScoreEndScoreSec() {
    try {
      // Use msBySel (score time in ms) instead of refSecBySel (audio time)
      if (state?.timeline?.msBySel?.length) {
        const i = state.timeline.msBySel.length - 1;
        const lastStart = (state.timeline.msBySel[i] || 0) / 1000; // convert ms to seconds
        const dur = (state.timeline.metaBySel?.[i]?.duration) || 0; // score seconds
        return Math.max(0, lastStart + dur);
      }
      const vt = state?.audio?.visualTimes;
      if (vt?.times?.length) return vt.times[vt.times.length - 1] || 0;
    } catch(_) {}
    return null;
  }

  // Estimate beats per measure from selectable list
  function estimateBeatsPerMeasure() {
    try {
      if (!Array.isArray(state.selectable) || !state.selectable.length) return null;
      const byMeasure = new Map();
      for (const sel of state.selectable) {
        const mi = sel?.measureIndex; if (mi == null) continue;
        const b = (typeof computeDurBeatsForSelectable === 'function') ? computeDurBeatsForSelectable(sel) : 0;
        byMeasure.set(mi, (byMeasure.get(mi) || 0) + (b || 0));
      }
      if (!byMeasure.size) return null;
      // pick mode of rounded durations
      const hist = new Map();
      for (const [, beats] of byMeasure) {
        const r = Math.round((beats || 0) * 4) / 4;
        hist.set(String(r), (hist.get(String(r)) || 0) + 1);
      }
      let best=null, cnt=-1;
      for (const [k,c] of hist) if (c>cnt) { cnt=c; best=k; }
      const typical = parseFloat(best);
      return Number.isFinite(typical) && typical>0 ? typical : null;
    } catch(_) { return null; }
  }

  // Map score seconds to audio seconds if fingerprint map exists
  function scoreSecToAudioSec(t) {
    try {
      const tm = state?.align?.timeMap;
      if (Array.isArray(tm) && tm.length) {
        // binary search lower bound
        let lo=0, hi=tm.length-1;
        while (lo<hi) { const mid=(lo+hi)>>1; if (tm[mid].scoreSec < t) lo=mid+1; else hi=mid; }
        const i = Math.max(1, lo);
        const a0 = tm[i-1], a1 = tm[i] || a0;
        const denom = Math.max(1e-6, a1.scoreSec - a0.scoreSec);
        const r = (t - a0.scoreSec) / denom;
        return a0.audioSec + r*(a1.audioSec - a0.audioSec);
      }
    } catch(_) {}
    return t; // fallback 1:1
  }

  // Compute end of NEXT measure in score seconds (prefer actual next measure if present)
  function getNextMeasureEndScoreSec() {
    try {
      if (!Array.isArray(state.selectable) || !state.selectable.length) return null;
      if (!state?.timeline?.msBySel?.length || !state?.timeline?.metaBySel?.length) return null;
      const lastIdx = state.selectable.length - 1;
      const lastMsr = state.selectable[lastIdx]?.measureIndex;
      if (lastMsr == null) return null;
      let end = -1, saw=false;
      for (let i=0; i<state.selectable.length; i++) {
        const sel = state.selectable[i];
        if (sel?.measureIndex === (lastMsr + 1)) {
          saw = true;
          const start = (state.timeline.msBySel[i] || 0) / 1000; // convert ms to seconds
          const dur = state.timeline.metaBySel?.[i]?.duration || 0;
          end = Math.max(end, start + dur);
        }
      }
      if (saw && end >= 0) return end;
    } catch(_) { }
    // fallback: add one typical bar to printed end
    const base = getScoreEndScoreSec();
    const beats = estimateBeatsPerMeasure() ?? 4;
    const bpm = state?.transportBPM || 120;
    return Number.isFinite(base) ? base + (beats * (60/(bpm||120))) : null;
  }

  // === knobs ===
  const START_AHEAD_SEC = 0.50; // fade begins this many seconds before target
  const FADE_MS = 600;          // fade duration (ms)

  function clearFadeWatcher() {
    const a = state?.audio?.referenceAudio;
    if (!a || !state?.audio) return;
    if (state.audio._nmFadeInt) { clearInterval(state.audio._nmFadeInt); state.audio._nmFadeInt = null; }
    if (state.audio._nmTU) { try { a.removeEventListener('timeupdate', state.audio._nmTU); } catch(_) {}
      state.audio._nmTU = null; }
    state.audio._nmFading = false;
    state.audio._nmPreVol = undefined;
  }

  function installFadeWatcher() {
    const a = state?.audio?.referenceAudio;
    if (!a) return;
    clearFadeWatcher();

    let cachedTarget = null;
    const onTU = () => {
      try {
        if (!Number.isFinite(cachedTarget)) {
          const targetScore = getNextMeasureEndScoreSec();
          if (Number.isFinite(targetScore)) cachedTarget = scoreSecToAudioSec(targetScore);
        }
        if (!Number.isFinite(cachedTarget)) return;
        const dur = Number.isFinite(a.duration) ? a.duration : Infinity;
        const endSec = Math.min(cachedTarget, Math.max(0, dur - 0.05));
        if (!state.audio._nmFading && a.currentTime >= (endSec - START_AHEAD_SEC)) {
          state.audio._nmFading = true;
          state.audio._nmPreVol = a.volume;
          const steps = Math.max(8, Math.round(FADE_MS/40));
          const dt = FADE_MS/steps; let i=0;
          state.audio._nmFadeInt = setInterval(() => {
            i++; const left = Math.max(0, 1 - i/steps);
            try { a.volume = (state.audio._nmPreVol ?? 1) * left; } catch(_){}
            if (i >= steps) {
              clearInterval(state.audio._nmFadeInt); state.audio._nmFadeInt = null;
              try { a.pause(); a.currentTime = endSec; } catch(_){}
              try { a.volume = (state.audio._nmPreVol ?? 1); } catch(_){}
              state.audio._nmFading = false;
            }
          }, dt);
        }
      } catch(_) { }
    };
    state.audio._nmTU = onTU;
    a.addEventListener('timeupdate', onTU);
  }

  window.__installNextMeasureFade = installFadeWatcher;
  window.__clearNextMeasureFade = clearFadeWatcher;
})();
/* === /Auto-fade (next-measure) === */


/* === Next-measure fade: resilient wiring loop (non-invasive) ===================== */
(function(){
  let wired = false;
  function tryWire() {
    try {
      const a = state && state.audio && state.audio.referenceAudio;
      if (!a || wired) return;
      wired = true;
      // Install on key lifecycle events
      a.addEventListener('play', () => { try { window.__installNextMeasureFade && window.__installNextMeasureFade(); } catch(_){} });
      a.addEventListener('loadedmetadata', () => { try { window.__installNextMeasureFade && window.__installNextMeasureFade(); } catch(_){} });
      a.addEventListener('seeked', () => { try { window.__installNextMeasureFade && window.__installNextMeasureFade(); } catch(_){} });
      a.addEventListener('pause', () => { try { window.__clearNextMeasureFade && window.__clearNextMeasureFade(); } catch(_){} });
      a.addEventListener('ended', () => { try { window.__clearNextMeasureFade && window.__clearNextMeasureFade(); } catch(_){} });
    } catch(_){}
  }
  setInterval(tryWire, 400);
  window.addEventListener('load', tryWire);
})();
/* === /Next-measure fade: wiring loop ============================================ */
