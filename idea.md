Totally fair. If OSMD overlays keep fighting you, don’t force it. You can still make the app feel like a game without drawing inside the score at all. Here’s a clean, overlay-free plan that’s robust, simple to wire, and uses the pieces you already have (selection events, MIDI playback, and the G4 game logic).

Gamification v2 (no OSMD overlays)

What we’ll build (small, solid pieces)
	1.	Score & Streak HUD — shows points, combo, accuracy %, and a star grade.
	2.	Checkpoints — the piece is split into bite-sized “checkpoints” (either every N notes or per measure if you already tag measureIndex). Playback auto-loops the current checkpoint; when all its notes are correct, you advance.
	3.	Modes — pick one:
	•	Accuracy Mode (whole piece, no loops): score from correctness only.
	•	Checkpoint Mode (loop windows): auto-advance when solved.
	•	Time Trial (optional): beat the clock for a checkpoint or the whole piece.
	4.	Persistence — saves best streak/score per file in localStorage.

No coloring in the notation; all feedback is in the HUD and the playback loop.

⸻

1) State: one small bucket under your existing Game Mode

// at app boot, alongside your existing state.gameMode
state.gameMode.gamify = {
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
};


⸻

2) HUD (pure HTML next to your existing controls)

In index.html, inside the controls panel (no score DOM needed):

<div id="gamifyHud" class="gamify-hud" hidden>
  <div class="gamify-row">
    <span id="gmScore"   class="gm-pill">Score: 0</span>
    <span id="gmStreak"  class="gm-pill">Streak: 0</span>
    <span id="gmAcc"     class="gm-pill">Accuracy: 0%</span>
    <span id="gmGrade"   class="gm-pill">—</span>
  </div>
  <div class="gamify-row">
    <button id="gmPrev"  type="button">⟵</button>
    <span   id="gmLabel">Checkpoint 1/1</span>
    <button id="gmNext"  type="button">⟶</button>
    <button id="gmRetry" type="button">Retry</button>
  </div>
</div>

Add minimal CSS:

.gamify-hud { display:flex; flex-direction:column; gap:6px; margin:6px 0; }
.gamify-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.gm-pill { background:#f3f4f6; border-radius:14px; padding:4px 10px; font-weight:600; }
#gmLabel { min-width: 140px; text-align:center; }
.gamify-hud button { min-height:32px; min-width:40px; }


⸻

3) Wiring the HUD

const hud = {
  root:  document.getElementById('gamifyHud'),
  score: document.getElementById('gmScore'),
  streak:document.getElementById('gmStreak'),
  acc:   document.getElementById('gmAcc'),
  grade: document.getElementById('gmGrade'),
  label: document.getElementById('gmLabel'),
  prev:  document.getElementById('gmPrev'),
  next:  document.getElementById('gmNext'),
  retry: document.getElementById('gmRetry'),
};

function showGamifyHud(show) { hud.root.hidden = !show; }

function updateGamifyHud() {
  const g = state.gameMode.gamify;
  hud.score.textContent  = `Score: ${g.score}`;
  hud.streak.textContent = `Streak: ${g.streak}`;
  const acc = g.total ? Math.round((g.hits/g.total)*100) : 0;
  hud.acc.textContent    = `Accuracy: ${acc}%`;
  hud.grade.textContent  = gradeFromAccuracy(acc);
  const totalCk = g.checkpoints.length || 1;
  hud.label.textContent  = `Checkpoint ${(g.current||0)+1}/${totalCk}`;
}

function gradeFromAccuracy(pct) {
  if (pct >= 98) return 'S';
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  return 'D';
}

Bind buttons:

hud.prev.onclick = () => gotoCheckpoint(state.gameMode.gamify.current - 1);
hud.next.onclick = () => gotoCheckpoint(state.gameMode.gamify.current + 1);
hud.retry.onclick = () => retryCheckpoint();


⸻

4) Checkpoints without touching OSMD

A) Segment by rests if available, else by fixed N notes

(This reuses your existing selectable list only.)

function buildCheckpoints() {
  const N = state.selectable?.length || 0;
  const S = state.selectable || [];
  const cps = [];

  // Try rest-based chunks first (simple phrases)
  let start = null, lastNote = null;
  for (let i = 0; i < N; i++) {
    const it = S[i];
    if (it.type === 'rest') {
      if (start != null && lastNote != null && lastNote >= start) {
        cps.push({ startSel: start, endSel: lastNote });
      }
      start = null; lastNote = null;
      continue;
    }
    if (start == null) start = i;
    lastNote = i;
  }
  if (start != null && lastNote != null && lastNote >= start) {
    cps.push({ startSel: start, endSel: lastNote });
  }

  // Fallback: fixed window (e.g., 12 notes)
  if (!cps.length) {
    const WIN = 12;
    for (let i = 0; i < N; i += WIN) {
      cps.push({ startSel: i, endSel: Math.min(i+WIN-1, N-1) });
    }
  }
  return cps;
}

B) Enter/exit gamify

function enterGamify(mode='checkpoint') {
  const g = state.gameMode.gamify;
  g.enabled = true; g.mode = mode;
  g.fileKey = `${state.fileHash||'nofile'}|${state.selectable?.length||0}`;
  g.score = 0; g.streak = 0; g.hits = 0; g.total = 0; g.bestStreak = 0;
  g.checkpoints = buildCheckpoints();
  g.current = 0;
  g.startedAt = performance.now();

  showGamifyHud(true);
  gotoCheckpoint(0);
  updateGamifyHud();
}

function exitGamify() {
  const g = state.gameMode.gamify;
  g.enabled = false;
  showGamifyHud(false);
  if (window.Tone) { Tone.Transport.loop = false; }
}

(You can call enterGamify() when Game Mode is toggled on, and exitGamify() when toggled off.)

⸻

5) Constrain playback to the active checkpoint (loop)

This is the loop-only piece you want; still no score coloring in the notation.

function currentCheckpoint() {
  const g = state.gameMode.gamify;
  return g.checkpoints[g.current] || null;
}

function clampTransportToCheckpoint() {
  const c = currentCheckpoint();
  if (!c) { if (window.Tone) Tone.Transport.loop = false; return; }

  const startSec = (state.timeline.msBySel[c.startSel]||0)/1000;
  const endSec   = (state.timeline.msBySel[c.endSel]  ||0)/1000
                 + beatsToSeconds(durationBeatsOfSel(c.endSel));

  if (window.Tone) {
    Tone.Transport.setLoopPoints(startSec, endSec);
    Tone.Transport.loop = true;
    if (Tone.Transport.state === 'started') {
      const pos = Tone.Transport.seconds;
      if (pos < startSec || pos >= endSec) Tone.Transport.seconds = startSec;
    }
  }

  // Reference audio (if aligned)
  if (state.audio?.referenceAudio && hasRefTimes(c)) {
    setupReferenceLoop(c);
  }
}

function hasRefTimes(c) {
  const s = state.timeline.refSecBySel[c.startSel];
  const e = state.timeline.refSecBySel[c.endSel];
  return typeof s === 'number' && typeof e === 'number';
}
function setupReferenceLoop(c) {
  const a = state.audio.referenceAudio;
  const s = state.timeline.refSecBySel[c.startSel];
  const e = state.timeline.refSecBySel[c.endSel]
          + beatsToSeconds(durationBeatsOfSel(c.endSel));
  if (state._refTimeHandler) a.removeEventListener('timeupdate', state._refTimeHandler);
  state._refTimeHandler = () => {
    if (a.currentTime >= e) { a.currentTime = s; if (a.paused) a.play().catch(()=>{}); }
  };
  a.addEventListener('timeupdate', state._refTimeHandler);
  // If currently playing, clamp into window
  if (!a.paused && (a.currentTime < s || a.currentTime >= e)) a.currentTime = s;
}

function beatsToSeconds(beats) {
  const bpm = state.transportBPM || 120;
  return (beats * 60) / bpm;
}
function durationBeatsOfSel(selIdx) {
  return state.timeline.metaBySel?.[selIdx]?.durBeats || 0;
}

Call clampTransportToCheckpoint():
	•	inside gotoCheckpoint() (shown below),
	•	right after you hit Play MIDI (after scheduling and before Transport.start()),
	•	right after Play Reference (if you allow reference).

⸻

6) Navigation & completion

function gotoCheckpoint(i) {
  const g = state.gameMode.gamify;
  if (!g.enabled) return;
  const N = g.checkpoints.length;
  g.current = Math.max(0, Math.min(i, N-1));

  // move selection to start for user context
  const c = currentCheckpoint();
  if (c) { state.index = c.startSel; applySelectionColor?.({ scroll:true }); }

  clampTransportToCheckpoint();
  updateGamifyHud();
}

function retryCheckpoint() {
  const g = state.gameMode.gamify;
  g.streak = 0;
  // You can also reset any “solved” bookkeeping if you keep it
  clampTransportToCheckpoint();
  updateGamifyHud();
}


⸻

7) Scoring hook (no drawing needed)

You already have a choke-point when the cursor advances (e.g., gameModeOnCursorAdvance() or wherever you call your “correctness” code). Add this minimal scoreboard there:

function onCursorAdvanceSelectable(selIdx) {
  if (!state.gameMode?.enabled) return;

  // correctness (use your existing logic / G4 vs original map)
  const correct = isCurrentNoteCorrect(selIdx);

  // Gamify scoring
  const g = state.gameMode.gamify;
  if (!g.enabled) return;
  // Count only playable notes
  if (state.selectable[selIdx]?.type === 'note') {
    g.total++;
    if (correct) {
      g.hits++;
      g.streak++;
      g.bestStreak = Math.max(g.bestStreak, g.streak);
      g.score += 100 + 10 * Math.min(g.streak, 20);  // simple combo bonus
    } else {
      g.streak = 0;
      g.score = Math.max(0, g.score - 50);           // light penalty
    }
  }

  // Auto-advance if checkpoint solved
  if (g.mode === 'checkpoint') {
    const c = currentCheckpoint();
    if (c && selIdx >= c.endSel) {
      // “Solved” = all notes in checkpoint were correct since we entered it.
      // If you need stricter logic, track per-checkpoint hits/total.
      gotoCheckpoint(g.current + 1);
    }
  }

  updateGamifyHud();
}

Where isCurrentNoteCorrect(selIdx) can be your existing compare:
	•	if you convert notes to G4 visually in Game Mode, keep an originalMidiBySel[] snapshot when entering Game Mode and compare the user-edited MIDI to original MIDI for that selIdx.

⸻

8) Persistence (optional but nice)

function saveGamify() {
  const g = state.gameMode.gamify;
  if (!g.fileKey) return;
  const bestKey = `gm:${g.fileKey}:best`;
  const prev = JSON.parse(localStorage.getItem(bestKey) || 'null');
  const acc = g.total ? g.hits / g.total : 0;
  const curr = { score: g.score, bestStreak: g.bestStreak, acc };
  if (!prev || curr.score > prev.score) {
    localStorage.setItem(bestKey, JSON.stringify(curr));
  }
}

Call saveGamify() when exiting Game Mode or when user finishes the last checkpoint.

⸻

9) Where to hook everything (summary)
	•	On Game Mode ON: enterGamify('checkpoint') (or expose a selector to choose mode).
	•	On Game Mode OFF: exitGamify().
	•	After render + after alignment: keep your rebuildTimeline() as you have it (it already builds msBySel and refSecBySel). No notation changes required.
	•	On Play MIDI: schedule as usual, then clampTransportToCheckpoint(), then Tone.Transport.start().
	•	On Play Reference: if allowed, clampTransportToCheckpoint() will ensure loop via timeupdate.
	•	On cursor advance: call onCursorAdvanceSelectable(selIdx).

⸻

Why this will feel “gamey” without touching OSMD
	•	The user sees progress in the HUD (score/accuracy/grade) and hears the looped checkpoint until they move on.
	•	No overlays or note coloring = no dependency on how OSMD renders internal groups.
	•	The whole flow is driven by selection indices and Transport/Audio—the parts you

---

## Feedback on Gamification v2 Plan

This is an excellent evolution from the previous phrase-based approach! The overlay-free design elegantly sidesteps the OSMD rendering complexities while delivering a compelling game experience.

### Strengths

**🎯 Smart Architecture**
- Clean separation between game logic and score rendering eliminates OSMD integration headaches
- HUD-based feedback is more prominent and user-friendly than subtle note coloring
- Reuses existing infrastructure (selection system, timeline, MIDI playback) efficiently

**🎮 Game Design**
- Multiple modes (checkpoint/accuracy/time trial) provide variety and replay value
- Streak/combo system with score bonuses creates engaging progression
- Auto-advance checkpoints maintain flow while allowing manual navigation
- Grade system (S/A/B/C/D) gives clear performance feedback

**🔧 Technical Robustness**
- Rest-based segmentation with fixed-window fallback is intelligent
- Proper loop handling for both MIDI (Tone.js) and reference audio
- Persistence system encourages improvement over time
- State management integrates cleanly with existing game mode structure

### Implementation Considerations

**Integration Points**
- The `onCursorAdvanceSelectable()` hook fits perfectly with existing `editCurrent()` flow
- `clampTransportToCheckpoint()` should integrate smoothly with current playback system
- HUD placement in controls panel maintains UI consistency

**Potential Enhancements**
- Consider visual feedback for checkpoint boundaries (subtle measure highlighting?)
- Speed control integration from memory could enhance learning experience
- Progress indicators for current checkpoint completion
- Sound effects for correct/incorrect notes and checkpoint completion

**Testing Strategy**
- Start with checkpoint mode as it's the most complete feature
- Test with various song structures (with/without rests, different lengths)
- Verify loop behavior with both MIDI and reference audio
- Ensure proper cleanup when switching between modes

### Recommendation

This design is ready for implementation. The modular approach allows incremental development:
1. Core HUD and state management
2. Checkpoint segmentation and navigation  
3. Scoring system integration
4. Loop playback constraints
5. Persistence and polish features

The overlay-free approach will be much more maintainable and reliable than fighting with OSMD's internal rendering system.

---

## Implementation Questions

After analyzing the current codebase, I have several clarifying questions before implementing the gamification v2 system:

### 1. Integration with Existing Game Mode
The current game mode converts all notes to G4 and tracks original vs current pitches. Should the new gamification system:
- **Replace** the existing game mode entirely, or
- **Extend** it by adding the HUD/checkpoint features on top of the G4 conversion?
- How should we handle the existing `state.gameMode.originalNoteMidiByXmlIndex` mapping?

### 2. Timeline Infrastructure
I see references to timeline/visual timing but need to understand:
- Does the current codebase already have `state.timeline.msBySel` and `state.timeline.refSecBySel` arrays?
- Where is the timeline built/rebuilt? Should I create this infrastructure or does it exist?
- How does the current `getStartFromSelection()` and `computeVisualTimes()` relate to the needed timeline?

### 3. Checkpoint Segmentation Strategy
For the rest-based segmentation:
- Should rests in `state.selectable` be treated as phrase boundaries?
- What's the preferred fallback window size (12 notes as suggested, or different)?
- Should we segment by measures instead, using the existing `measureIndex` property?

### 4. Correctness Detection
For scoring, I need to clarify:
- Should correctness compare current MIDI vs original MIDI (from `originalNoteMidiByXmlIndex`)?
- Or should it compare against some other reference (like the reference audio alignment)?
- How should tied notes be handled in scoring (as single units or individual notes)?

### 5. Speed Control Integration
From the memory about speed control (1%-100%):
- Should checkpoint playback respect the current speed slider value?
- How does this interact with the existing `state.speed` multiplier?
- Should the gamification system have its own speed control or use the global one?

### 6. UI Placement
For the HUD location:
- Should it go in the existing `.controls` section or create a new section?
- Should it be always visible when game mode is on, or toggleable?
- Any specific styling preferences to match the current design?

### 7. Persistence Strategy
For the localStorage persistence:
- Should it use the existing `state.fileHash` for the key?
- What data should persist: just scores/streaks, or also checkpoint progress?
- Should it integrate with the existing selection persistence (`sel_${fileHash}`)?

### 8. Event Integration Points
I see the current `editCurrent()` function and `gameModeOnCursorAdvance()` hook:
- Should the scoring logic hook into `editCurrent()` directly?
- Or should it use the existing `gameModeOnCursorAdvance()` function?
- How should it interact with the mouse drag editing system?

Please clarify these points so I can implement the system correctly integrated with your existing architecture. 

Great call to simplify. Below are firm decisions so you can implement Gamification v2 cleanly with your current codebase (no OSMD overlays needed).

⸻

1) Integration with Existing Game Mode

Decision: Extend the existing Game Mode. Keep the current “all notes → G4” behavior as an optional sub-mode (call it Monotone), and layer the HUD/checkpoints on top.
	•	Keep using state.gameMode.originalNoteMidiByXmlIndex as your ground truth for “what the note should be.”
	•	On entry to Game Mode (or when you first enable Gamify), also prepare:
	•	originalMidiBySel[selIndex] = originalNoteMidiByXmlIndex.get(sel.xmlIndex) (once per load).
	•	Correctness then compares the current pitch for that selIndex against originalMidiBySel[selIndex], regardless of whether you visually render as G4 or original.
Monotone is purely a rendering/ear training option; the correctness reference remains the original pitch.

⸻

2) Timeline Infrastructure

Decision: If you already have timing arrays, reuse; if not, create a minimal, per-selectable timeline.
	•	Use (or create) these arrays:
	•	state.timeline.msBySel (number[]): onset milliseconds per selIndex.
	•	state.timeline.refSecBySel (number[] | null[]): aligned seconds per selIndex (null if no alignment).
	•	state.timeline.metaBySel[selIndex].durBeats (number): note duration in beats (for end-time computation).
	•	Build/Rebuild timeline:
	•	After OSMD render (you can derive seconds per visual index; map to selectables).
	•	After alignment completes (to fill refSecBySel).
	•	Existing helpers:
	•	If you already compute visual times (seconds), set state.audio.visualTimes = { times:[sec,…] }.
	•	Then msBySel[sel] = visualSec[ selToVisual[sel] ] * 1000.
	•	refSecBySel[sel] comes from your alignment map (or stays null).

Bottom line: Provide per-selectable onset ms and aligned seconds; the gamify loop code uses only those.

⸻

3) Checkpoint Segmentation Strategy

Decision: Segment by rests in state.selectable. That’s your primary rule.
Fallback if there are no rests: fixed window of 12 notes (tuneable).
Optional: if you already attach measureIndex and prefer coarser chunks, you can offer a toggle later; but default to rest-based to feel “phrase-like.”

⸻

4) Correctness Detection

Decision: Compare current MIDI vs original MIDI (from originalMidiBySel). No need to involve reference audio for correctness.
	•	When the cursor advances to selIndex (during playback), compute:
	•	correct = (currentMidiForSel(selIndex) === originalMidiBySel[selIndex])
	•	Ties: if your state.selectable already groups a tie chain into one selectable, count it once (good). If not grouped, count only the start note and ignore the continuation notes for scoring.

⸻

5) Speed Control Integration

Decision: Respect the global speed control (state.speed) only; don’t add a new one.
	•	Your MIDI scheduler/Transport BPM scaling should already read state.speed. The gamify loop points are set in seconds; they remain correct as speed changes because Transport plays faster/slower within those boundaries.
	•	No special handling in gamify code beyond calling clampTransportToCheckpoint() after speed changes (optional polish).

⸻

6) UI Placement

Decision: Put the HUD in the existing .controls area, directly under the Game Mode toggle; show it whenever Game Mode is ON (and hide when OFF). No separate toggle.
	•	Keep it minimal: Score, Streak, Accuracy, Grade + Prev / Next / Retry buttons.
	•	Follow your current styling (rounded “pill” spans, small buttons). No need to touch the score SVG.

⸻

7) Persistence Strategy

Decision: Use state.fileHash to key saved results; keep gamify data separate from selection persistence.
	•	Key: gm:${state.fileHash}|${state.selectable.length}|${mode}
	•	Persist: { bestScore, bestStreak, bestAccuracy, lastCheckpoint }
	•	Save on mode exit or when reaching the end.
	•	Restore on load to show “Personal Best” (optional).

⸻

8) Event Integration Points

Decision: Hook scoring into the cursor advance path (e.g., gameModeOnCursorAdvance(visualIdx) → convert to selIndex → onCursorAdvanceSelectable(selIdx)).
	•	Do not score inside editCurrent() or mouse-drag edits—edits change the candidate pitch, but scoring should only happen when playback cursor hits a note.
	•	For mouse dragging, simply update the current pitch; scoring will pick it up on the next cursor hit.

⸻

Quick “do this” checklist
	1.	On Game Mode ON → call enterGamify('checkpoint'):
	•	Build originalMidiBySel[] from your XML map.
	•	Build checkpoints (rests → phrases; else 12-note windows).
	•	Build/refresh timeline (msBySel, refSecBySel, durBeats) if not fresh.
	•	Show HUD, gotoCheckpoint(0), clampTransportToCheckpoint().
	2.	On Play MIDI:
	•	Schedule only notes where selIndex ∈ [startSel..endSel].
	•	Set Transport loop points to [msStart, msEnd] (convert to seconds).
	•	Start transport.
	3.	On Play Reference (optional if aligned):
	•	If refSecBySel is available, loop [startRef, endRef] via timeupdate.
	4.	On Cursor Advance:
	•	Convert visual index → selIndex.
	•	correct = (currentMidi === originalMidiBySel[selIndex]).
	•	Update score/streak/accuracy; if end of checkpoint, gotoCheckpoint(+1).
	5.	On Game Mode OFF → exitGamify() (hide HUD, disable loops).

⸻

## Final Implementation Questions

Based on your clear decisions, I have just a few specific technical questions:

### Timeline Building
- Should I create the `state.timeline` object structure if it doesn't exist?
- For `metaBySel[selIndex].durBeats`, should I extract this from the MusicXML `<duration>` elements or derive it differently?
- When you mention "derive seconds per visual index" - should I use the existing `computeVisualTimes()` function?

### Visual to Selectable Mapping
- I need to convert `visualIdx` to `selIndex` in the cursor advance hook. Should I create a `visualToSel[]` mapping array during timeline building?
- How should I handle the case where multiple visual elements map to the same selectable (tied notes)?

### MIDI Scheduling Constraints
- For "Schedule only notes where selIndex ∈ [startSel..endSel]" - should I modify the existing MIDI scheduling code or create a separate checkpoint-aware scheduler?
- Should I filter at the scheduling level or at the note triggering level?

### Current MIDI Extraction
- For `currentMidiForSel(selIndex)`, should I read from the current DOM state or maintain a separate tracking array?
- Should I use the existing `noteXmlToMidi()` function on the current selectable's domNodes?

### Game Mode Toggle Integration
- Should `enterGamify()` be called from the existing game mode toggle event handler, or do I need to create a separate integration point?
- Should the existing `enterGameMode()`/`exitGameMode()` functions be modified to call `enterGamify()`/`exitGamify()`?

These clarifications will let me implement the system without any architectural conflicts.

⸻

Awesome—here are crisp, “do-this” answers for each point so you can wire Gamification v2 without stepping on existing code.

⸻

Timeline Building
	•	Create state.timeline if missing?
Yes. Do this once at app boot (or before first rebuild):

state.timeline = state.timeline || { msBySel: [], refSecBySel: [], metaBySel: [] };
state.maps     = state.maps     || { visualToSel: [], selToVisual: [] };


	•	Where does metaBySel[selIndex].durBeats come from?
From MusicXML <duration> in divisions units:

durBeats = durationDivs / divisions

If a selectable groups a tie chain, sum all notes in that chain:

function computeDurBeatsForSelectable(sel) {
  // sel.xmlNotes or sel.domNodes that point to the XML notes
  let beats = 0;
  for (const noteNode of sel.xmlNotes || sel.domNodes || []) {
    const dur = +(noteNode.querySelector('duration')?.textContent || 0);
    const div = +(noteNode.closest('measure')?.querySelector('divisions')?.textContent
                  || state.globalDivisions || 1);
    beats += dur / div;
  }
  return beats;
}
// during rebuild:
state.timeline.metaBySel = state.selectable.map(sel => ({ durBeats: computeDurBeatsForSelectable(sel) }));

If you don’t have xmlNotes, you can fall back to OSMD’s duration data (if exposed) or your existing duration estimator—goal is a reasonable end time for the loop.

	•	“Derive seconds per visual index” — use computeVisualTimes()?
Use your existing function as a seconds source. If yours returns ms, normalize once:

function computeVisualTimesSec() {
  const vt = computeVisualTimes(); // existing
  const times = vt.times;
  const sec = (times.length && times[0] > 300) ? times.map(t => t/1000) : times;
  return { times: sec, nodes: vt.nodes, divisions: vt.divisions };
}
// building msBySel:
const visual = state.audio?.visualTimes || computeVisualTimesSec();
state.timeline.msBySel = state.selectable.map((_, sel) => {
  const v = state.maps.selToVisual[sel];
  const sec = (v != null ? visual.times[v] : 0);
  return sec * 1000;
});



⸻

Visual → Selectable Mapping
	•	Create visualToSel[] during timeline build?
Yes. Build both directions after render (when both visual timeline and selectables exist):

function buildVisualSelMaps(visualNodes /* optional */) {
  const map = [];   // visualIdx -> selIndex
  // Fill `map` by using your existing xml-index bridge (fastest path in your codebase):
  // e.g., if you already have a builder, just call it and alias the result:
  // state.maps.visualToSel = existingVisualToSelMap;
  // Otherwise, do a best-effort join from visual node -> xmlIndex -> selIndex.
  state.maps.visualToSel = map;

  // First visual index per selectable (anchor)
  state.maps.selToVisual = [];
  map.forEach((selIdx, vIdx) => {
    if (selIdx != null && state.maps.selToVisual[selIdx] == null) {
      state.maps.selToVisual[selIdx] = vIdx;
    }
  });
}


	•	Multiple visuals → same selectable (ties)?
Allowed. To avoid double-scoring, only score when the cursor hits the anchor visual for that selIndex:

function onCursorAdvanceVisual(visualIdx) {
  const selIdx = state.maps.visualToSel[visualIdx];
  if (selIdx == null) return;
  if (visualIdx !== state.maps.selToVisual[selIdx]) return; // skip tie-continuations
  onCursorAdvanceSelectable(selIdx);
}



⸻

MIDI Scheduling Constraints
	•	Modify existing scheduler vs new one?
Modify the existing scheduler: add a simple window guard and set loop points. It’s less code and preserves your current playback features.

function inActiveWindow(selIdx) {
  if (!state.gameMode?.gamify?.enabled) return true;
  const ck = currentCheckpoint();
  return ck ? selIdx >= ck.startSel && selIdx <= ck.endSel : true;
}

// in your scheduling loop:
for (let selIdx = 0; selIdx < state.selectable.length; selIdx++) {
  const sel = state.selectable[selIdx];
  if (sel.type !== 'note') continue;
  if (!inActiveWindow(selIdx)) continue;
  // schedule note as you already do...
}
// after scheduling:
clampTransportToCheckpoint(); // sets Transport loop points


	•	Filter at scheduling or trigger time?
Scheduling time (best for CPU and correctness). You can keep a lightweight guard at trigger time too, but primary filter should be at scheduling.

⸻

Current MIDI Extraction
	•	Source of truth for currentMidiForSel(selIndex)?
Don’t scrape the DOM. Use your current state mapping. You already track per-XML current pitches; bridge via xmlIndex:

function currentMidiForSel(selIdx) {
  const xmlIdx = state.selectable[selIdx]?.xmlIndex;
  return state.gameMode.currentNoteMidiByXmlIndex.get(xmlIdx);
}
function originalMidiForSel(selIdx) {
  const xmlIdx = state.selectable[selIdx]?.xmlIndex;
  return state.gameMode.originalNoteMidiByXmlIndex.get(xmlIdx);
}

(If you prefer, build originalMidiBySel[] once on enter and read from that array; but the Map + xmlIndex bridge is fine and keeps you in sync with your existing edit pipeline.)

	•	Use noteXmlToMidi() on demand?
Only if you truly lack the Map. The Map route is faster and consistent with your editor. Keep noteXmlToMidi as a fallback.

⸻

Game Mode Toggle Integration
	•	Where to call enterGamify()?
From your existing Game Mode toggle path (where you already call enterGameMode()). The clean pattern:

async function enterGameMode() {
  // existing game prep…
  enterGamify('checkpoint');   // NEW
}
async function exitGameMode() {
  // existing teardown…
  exitGamify();                // NEW
}


	•	Separate integration point needed?
No. Piggyback on the existing toggle and lifecycle. The HUD shows only when Game Mode is ON; hide it on OFF.

⸻

Tiny end-to-end order of operations (for sanity)
	1.	Render OSMD → build selectables.
	2.	Build visual times (seconds) → state.audio.visualTimes = computeVisualTimesSec().
	3.	Build maps → buildVisualSelMaps().
	4.	Rebuild timeline → fills msBySel, refSecBySel, metaBySel.durBeats.
	5.	Enter Game Mode → enterGameMode() → enterGamify('checkpoint') builds checkpoints (rests), HUD, sets current window.
	6.	Play MIDI → schedule only notes in window + clampTransportToCheckpoint() + Transport.start().
	7.	Cursor advance → onCursorAdvanceVisual(vIdx) → anchor de-dup → onCursorAdvanceSelectable(selIdx) → score.
	8.	Next checkpoint → gotoCheckpoint(+1) → clamp loop → continue.

Follow this, and everything stays in one consistent index space and timing domain.

---

## Ready for Implementation

All questions answered! The implementation plan is complete and clear:

✅ **Architecture**: Extend existing game mode with HUD/checkpoints  
✅ **Timeline**: Create `state.timeline` + `state.maps` structures  
✅ **Mapping**: Build `visualToSel`/`selToVisual` with anchor deduplication  
✅ **Scheduling**: Modify existing scheduler with window guards  
✅ **Scoring**: Use existing XML index maps for MIDI comparison  
✅ **Integration**: Hook into existing `enterGameMode()`/`exitGameMode()`  
✅ **Flow**: Clear 8-step end-to-end operation sequence  

Ready to implement the gamification v2 system with no architectural conflicts.

---

## Full Implementation Plan

### Step 1: Initialize Timeline and Mapping Infrastructure

**Location**: Add to `app.js` after state initialization

```javascript
// Initialize timeline and mapping structures
state.timeline = state.timeline || { msBySel: [], refSecBySel: [], metaBySel: [] };
state.maps = state.maps || { visualToSel: [], selToVisual: [] };

// Helper function to compute duration in beats for selectables
function computeDurBeatsForSelectable(sel) {
  let beats = 0;
  for (const noteNode of sel.domNodes || []) {
    const dur = +(noteNode.querySelector('duration')?.textContent || 0);
    const div = +(noteNode.closest('measure')?.querySelector('divisions')?.textContent || 1);
    beats += dur / div;
  }
  return beats;
}

// Normalize visual times to seconds
function computeVisualTimesSec() {
  const vt = computeVisualTimes(state.transportBPM || 120);
  const times = vt.times;
  const sec = (times.length && times[0] > 300) ? times.map(t => t/1000) : times;
  return { times: sec, nodes: vt.nodes, divisions: vt.divisions };
}

// Build visual-selectable mapping
function buildVisualSelMaps() {
  const visualNodes = state.audio?.visualTimes?.nodes || [];
  const map = []; // visualIdx -> selIndex
  
  // Build mapping using existing XML index bridge
  visualNodes.forEach((node, vIdx) => {
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

// Rebuild timeline data
function rebuildTimeline() {
  if (!state.selectable?.length) return;
  
  // Build visual times
  const visual = computeVisualTimesSec();
  state.audio.visualTimes = visual;
  
  // Build mappings
  buildVisualSelMaps();
  
  // Build timeline arrays
  state.timeline.msBySel = state.selectable.map((_, selIdx) => {
    const vIdx = state.maps.selToVisual[selIdx];
    const sec = (vIdx != null ? visual.times[vIdx] : 0);
    return sec * 1000;
  });
  
  state.timeline.metaBySel = state.selectable.map(sel => ({
    durBeats: computeDurBeatsForSelectable(sel)
  }));
  
  // refSecBySel filled by alignment system (if available)
  if (!state.timeline.refSecBySel.length) {
    state.timeline.refSecBySel = new Array(state.selectable.length).fill(null);
  }
}
```

### Step 2: Add Gamification State Structure

**Location**: Extend `state.gameMode` object

```javascript
// Extend existing gameMode state
state.gameMode.gamify = {
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
};
```

### Step 3: Add HUD HTML Structure

**Location**: Add to `index.html` in the controls section after game mode toggle

```html
<!-- Add after the game mode toggle -->
<div id="gamifyHud" class="gamify-hud" hidden>
  <div class="gamify-row">
    <span id="gmScore" class="gm-pill">Score: 0</span>
    <span id="gmStreak" class="gm-pill">Streak: 0</span>
    <span id="gmAcc" class="gm-pill">Accuracy: 0%</span>
    <span id="gmGrade" class="gm-pill">—</span>
  </div>
  <div class="gamify-row">
    <button id="gmPrev" type="button">⟵</button>
    <span id="gmLabel">Checkpoint 1/1</span>
    <button id="gmNext" type="button">⟶</button>
    <button id="gmRetry" type="button">Retry</button>
  </div>
</div>
```

### Step 4: Add HUD CSS Styling

**Location**: Add to `style.css`

```css
/* Gamification HUD */
.gamify-hud { 
  display: flex; 
  flex-direction: column; 
  gap: 6px; 
  margin: 6px 0; 
  background: #f8f9fa;
  border: 1px solid #e9ecef;
  border-radius: 8px;
  padding: 8px;
}
.gamify-row { 
  display: flex; 
  align-items: center; 
  gap: 8px; 
  flex-wrap: wrap; 
}
.gm-pill { 
  background: #fff; 
  border: 1px solid #e5e5e5;
  border-radius: 14px; 
  padding: 4px 10px; 
  font-weight: 600; 
  font-size: 12px;
  color: #333;
}
#gmLabel { 
  min-width: 140px; 
  text-align: center; 
  font-weight: 500;
  color: #555;
}
.gamify-hud button { 
  min-height: 28px; 
  min-width: 36px; 
  font-size: 12px;
  padding: 4px 8px;
}
```

### Step 5: Implement Checkpoint System

**Location**: Add to `app.js`

```javascript
// Build checkpoints from rests or fixed windows
function buildCheckpoints() {
  const N = state.selectable?.length || 0;
  const S = state.selectable || [];
  const cps = [];

  // Try rest-based chunks first
  let start = null, lastNote = null;
  for (let i = 0; i < N; i++) {
    const it = S[i];
    if (it.type === 'rest') {
      if (start != null && lastNote != null && lastNote >= start) {
        cps.push({ startSel: start, endSel: lastNote });
      }
      start = null; lastNote = null;
      continue;
    }
    if (start == null) start = i;
    lastNote = i;
  }
  if (start != null && lastNote != null && lastNote >= start) {
    cps.push({ startSel: start, endSel: lastNote });
  }

  // Fallback: fixed window (12 notes)
  if (!cps.length) {
    const WIN = 12;
    for (let i = 0; i < N; i += WIN) {
      const endIdx = Math.min(i + WIN - 1, N - 1);
      // Only include if there are actual notes in this window
      const hasNotes = S.slice(i, endIdx + 1).some(sel => sel.type === 'note');
      if (hasNotes) {
        cps.push({ startSel: i, endSel: endIdx });
      }
    }
  }
  return cps;
}

// Get current checkpoint
function currentCheckpoint() {
  const g = state.gameMode.gamify;
  return g.checkpoints[g.current] || null;
}

// Navigate to checkpoint
function gotoCheckpoint(i) {
  const g = state.gameMode.gamify;
  if (!g.enabled) return;
  const N = g.checkpoints.length;
  g.current = Math.max(0, Math.min(i, N - 1));

  // Move selection to start for user context
  const c = currentCheckpoint();
  if (c) { 
    state.index = c.startSel; 
    applySelectionColor({ scroll: true }); 
  }

  clampTransportToCheckpoint();
  updateGamifyHud();
}

// Retry current checkpoint
function retryCheckpoint() {
  const g = state.gameMode.gamify;
  g.streak = 0;
  clampTransportToCheckpoint();
  updateGamifyHud();
}
```

### Step 6: Implement HUD Management

**Location**: Add to `app.js`

```javascript
// HUD element references
const hud = {
  root: document.getElementById('gamifyHud'),
  score: document.getElementById('gmScore'),
  streak: document.getElementById('gmStreak'),
  acc: document.getElementById('gmAcc'),
  grade: document.getElementById('gmGrade'),
  label: document.getElementById('gmLabel'),
  prev: document.getElementById('gmPrev'),
  next: document.getElementById('gmNext'),
  retry: document.getElementById('gmRetry'),
};

// Show/hide HUD
function showGamifyHud(show) { 
  if (hud.root) hud.root.hidden = !show; 
}

// Update HUD display
function updateGamifyHud() {
  const g = state.gameMode.gamify;
  if (!hud.root) return;
  
  hud.score.textContent = `Score: ${g.score}`;
  hud.streak.textContent = `Streak: ${g.streak}`;
  const acc = g.total ? Math.round((g.hits/g.total)*100) : 0;
  hud.acc.textContent = `Accuracy: ${acc}%`;
  hud.grade.textContent = gradeFromAccuracy(acc);
  const totalCk = g.checkpoints.length || 1;
  hud.label.textContent = `Checkpoint ${(g.current||0)+1}/${totalCk}`;
  
  // Update button states
  hud.prev.disabled = g.current <= 0;
  hud.next.disabled = g.current >= g.checkpoints.length - 1;
}

// Grade calculation
function gradeFromAccuracy(pct) {
  if (pct >= 98) return 'S';
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  return 'D';
}

// Bind HUD button events
function bindGamifyHudEvents() {
  if (!hud.prev) return; // Guard against missing elements
  
  hud.prev.onclick = () => gotoCheckpoint(state.gameMode.gamify.current - 1);
  hud.next.onclick = () => gotoCheckpoint(state.gameMode.gamify.current + 1);
  hud.retry.onclick = () => retryCheckpoint();
}
```

### Step 7: Implement Transport Loop Constraints

**Location**: Add to `app.js`

```javascript
// Constrain playback to active checkpoint
function clampTransportToCheckpoint() {
  const c = currentCheckpoint();
  if (!c) { 
    if (window.Tone) Tone.Transport.loop = false; 
    return; 
  }

  const startSec = (state.timeline.msBySel[c.startSel] || 0) / 1000;
  const endSec = (state.timeline.msBySel[c.endSel] || 0) / 1000
               + beatsToSeconds(state.timeline.metaBySel[c.endSel]?.durBeats || 0);

  if (window.Tone) {
    Tone.Transport.setLoopPoints(startSec, endSec);
    Tone.Transport.loop = true;
    if (Tone.Transport.state === 'started') {
      const pos = Tone.Transport.seconds;
      if (pos < startSec || pos >= endSec) Tone.Transport.seconds = startSec;
    }
  }

  // Reference audio loop (if aligned)
  if (state.audio?.referenceAudio && hasRefTimes(c)) {
    setupReferenceLoop(c);
  }
}

// Helper functions
function beatsToSeconds(beats) {
  const bpm = state.transportBPM || 120;
  return (beats * 60) / bpm;
}

function hasRefTimes(c) {
  const s = state.timeline.refSecBySel[c.startSel];
  const e = state.timeline.refSecBySel[c.endSel];
  return typeof s === 'number' && typeof e === 'number';
}

function setupReferenceLoop(c) {
  const a = state.audio.referenceAudio;
  const s = state.timeline.refSecBySel[c.startSel];
  const e = state.timeline.refSecBySel[c.endSel]
          + beatsToSeconds(state.timeline.metaBySel[c.endSel]?.durBeats || 0);
  
  if (state._refTimeHandler) a.removeEventListener('timeupdate', state._refTimeHandler);
  state._refTimeHandler = () => {
    if (a.currentTime >= e) { 
      a.currentTime = s; 
      if (a.paused) a.play().catch(() => {}); 
    }
  };
  a.addEventListener('timeupdate', state._refTimeHandler);
  
  // Clamp current position if playing
  if (!a.paused && (a.currentTime < s || a.currentTime >= e)) {
    a.currentTime = s;
  }
}
```

### Step 8: Add MIDI Scheduling Constraints

**Location**: Modify existing MIDI scheduling in `app.js`

```javascript
// Check if selectable index is in active window
function inActiveWindow(selIdx) {
  if (!state.gameMode?.gamify?.enabled) return true;
  const ck = currentCheckpoint();
  return ck ? selIdx >= ck.startSel && selIdx <= ck.endSel : true;
}

// Modify your existing MIDI scheduling loop to include:
// (Find the existing scheduling code and add the inActiveWindow check)

// Example integration in existing scheduler:
/*
for (let selIdx = 0; selIdx < state.selectable.length; selIdx++) {
  const sel = state.selectable[selIdx];
  if (sel.type !== 'note') continue;
  if (!inActiveWindow(selIdx)) continue; // NEW LINE
  // ... rest of existing scheduling code
}
// After scheduling, add:
clampTransportToCheckpoint(); // NEW LINE
*/
```

### Step 9: Implement Scoring System

**Location**: Add to `app.js`

```javascript
// Get current/original MIDI for scoring
function currentMidiForSel(selIdx) {
  const sel = state.selectable[selIdx];
  if (!sel || sel.type !== 'note') return null;
  const xmlIdx = sel.domNodes?.[0]?.getAttribute?.('data-xml-node-index');
  if (xmlIdx) {
    return state.gameMode.currentNoteMidiByXmlIndex.get(parseInt(xmlIdx));
  }
  return null;
}

function originalMidiForSel(selIdx) {
  const sel = state.selectable[selIdx];
  if (!sel || sel.type !== 'note') return null;
  const xmlIdx = sel.domNodes?.[0]?.getAttribute?.('data-xml-node-index');
  if (xmlIdx) {
    return state.gameMode.originalNoteMidiByXmlIndex.get(parseInt(xmlIdx));
  }
  return null;
}

// Cursor advance with scoring
function onCursorAdvanceVisual(visualIdx) {
  const selIdx = state.maps.visualToSel[visualIdx];
  if (selIdx == null) return;
  if (visualIdx !== state.maps.selToVisual[selIdx]) return; // skip tie-continuations
  onCursorAdvanceSelectable(selIdx);
}

function onCursorAdvanceSelectable(selIdx) {
  if (!state.gameMode?.enabled) return;

  // Correctness check
  const currentMidi = currentMidiForSel(selIdx);
  const originalMidi = originalMidiForSel(selIdx);
  const correct = (currentMidi != null && currentMidi === originalMidi);

  // Gamify scoring
  const g = state.gameMode.gamify;
  if (!g.enabled) return;
  
  // Count only playable notes
  if (state.selectable[selIdx]?.type === 'note') {
    g.total++;
    if (correct) {
      g.hits++;
      g.streak++;
      g.bestStreak = Math.max(g.bestStreak, g.streak);
      g.score += 100 + 10 * Math.min(g.streak, 20);  // combo bonus
    } else {
      g.streak = 0;
      g.score = Math.max(0, g.score - 50);           // penalty
    }
  }

  // Auto-advance if checkpoint solved
  if (g.mode === 'checkpoint') {
    const c = currentCheckpoint();
    if (c && selIdx >= c.endSel) {
      gotoCheckpoint(g.current + 1);
    }
  }

  updateGamifyHud();
}
```

### Step 10: Integrate with Game Mode Lifecycle

**Location**: Modify existing `enterGameMode()` and `exitGameMode()` functions

```javascript
// Gamification entry/exit
function enterGamify(mode = 'checkpoint') {
  const g = state.gameMode.gamify;
  g.enabled = true; 
  g.mode = mode;
  g.fileKey = `${state.fileHash || 'nofile'}|${state.selectable?.length || 0}`;
  g.score = 0; 
  g.streak = 0; 
  g.hits = 0; 
  g.total = 0; 
  g.bestStreak = 0;
  g.checkpoints = buildCheckpoints();
  g.current = 0;
  g.startedAt = performance.now();

  showGamifyHud(true);
  gotoCheckpoint(0);
  updateGamifyHud();
}

function exitGamify() {
  const g = state.gameMode.gamify;
  g.enabled = false;
  showGamifyHud(false);
  if (window.Tone) { Tone.Transport.loop = false; }
  
  // Clean up reference audio loop
  if (state._refTimeHandler && state.audio?.referenceAudio) {
    state.audio.referenceAudio.removeEventListener('timeupdate', state._refTimeHandler);
    state._refTimeHandler = null;
  }
}

// Modify existing functions:
async function enterGameMode() {
  if (state.gameMode.enabled) return;
  state.gameMode.enabled = true;

  // ... existing game mode setup code ...

  // NEW: Add gamification
  enterGamify('checkpoint');
}

async function exitGameMode() {
  if (!state.gameMode.enabled) return;

  // NEW: Exit gamification first
  exitGamify();

  // ... existing game mode teardown code ...
  
  state.gameMode.enabled = false;
}
```

### Step 11: Hook into Existing Cursor Advance

**Location**: Modify existing `gameModeOnCursorAdvance()` function

```javascript
// Update existing cursor advance handler
function gameModeOnCursorAdvance(visualIdx) {
  if (!state.gameMode.enabled) return;
  
  // NEW: Add gamification scoring
  onCursorAdvanceVisual(visualIdx);
  
  // ... existing game mode logic if any ...
}
```

### Step 12: Initialize on App Boot

**Location**: Add to app initialization code

```javascript
// Add to app boot sequence (after DOM loaded)
document.addEventListener('DOMContentLoaded', function() {
  // ... existing initialization ...
  
  // Initialize gamification
  bindGamifyHudEvents();
  
  // Hook into render completion
  const originalRenderCurrent = renderCurrent;
  renderCurrent = async function() {
    await originalRenderCurrent.call(this);
    rebuildTimeline(); // Rebuild after each render
  };
});
```

### Step 13: Persistence (Optional)

**Location**: Add to `app.js`

```javascript
// Save/load gamification progress
function saveGamify() {
  const g = state.gameMode.gamify;
  if (!g.fileKey) return;
  const bestKey = `gm:${g.fileKey}:best`;
  const prev = JSON.parse(localStorage.getItem(bestKey) || 'null');
  const acc = g.total ? g.hits / g.total : 0;
  const curr = { score: g.score, bestStreak: g.bestStreak, acc };
  if (!prev || curr.score > prev.score) {
    localStorage.setItem(bestKey, JSON.stringify(curr));
  }
}

// Call saveGamify() in exitGamify() or when completing all checkpoints
```

This implementation plan provides a complete, step-by-step approach to adding the gamification v2 system while maintaining compatibility with your existing codebase.


Absolutely—here’s a tight, end-to-end plan to ship Gamification v2 (HUD + checkpoints + looped playback) without touching OSMD internals.

⸻

0) Goals (what ships)
	•	HUD shows Score, Streak, Accuracy, Grade + Prev / Next / Retry.
	•	The piece is split into checkpoints (rests define boundaries; fallback to N notes).
	•	Playback loops only the active checkpoint (MIDI always; reference audio only if aligned).
	•	Scoring updates on cursor hits (not while editing).
	•	Works with your existing Game Mode and G4 (Monotone) option, but doesn’t depend on overlays.

⸻

1) Data model

In app.js (global state init):

state.timeline = state.timeline || { msBySel: [], refSecBySel: [], metaBySel: [] };
state.maps     = state.maps     || { visualToSel: [], selToVisual: [] };

state.gameMode.gamify = {
  enabled: false,
  mode: 'checkpoint',                // 'checkpoint' | 'accuracy' | 'timetrial' (future)
  // scoring
  score: 0, streak: 0, bestStreak: 0, hits: 0, total: 0,
  // checkpoints
  checkpoints: [],                   // [{ startSel, endSel }]
  current: 0,
  // persistence
  fileKey: null,                     // `${state.fileHash}|${state.selectable.length}|v1`
};


⸻

2) Timeline & mapping (build once after render, again after alignment)

2.1 Visual times (seconds)

Create a canonical helper:

function computeVisualTimesSec() {
  const vt = computeVisualTimes();           // your existing function
  const t  = vt?.times || [];
  const sec = (t.length && t[0] > 300) ? t.map(v => v/1000) : t; // normalize
  return { times: sec, nodes: vt?.nodes, divisions: vt?.divisions };
}

After OSMD render:

state.audio.visualTimes = computeVisualTimesSec();

2.2 Maps (visual ↔ selectable)

After render (when selectables exist):

function buildVisualSelMaps() {
  // Fill visualToSel using your existing bridge (xmlIndex or selectables tag)
  // Then create selToVisual (first visual occurrence per selectable)
  const v2s = /* existing function or join logic */ [];
  state.maps.visualToSel = v2s;
  state.maps.selToVisual = [];
  v2s.forEach((selIdx, vIdx) => {
    if (selIdx != null && state.maps.selToVisual[selIdx] == null) {
      state.maps.selToVisual[selIdx] = vIdx;
    }
  });
}

2.3 Rebuild timeline

function rebuildTimeline() {
  const visual = state.audio?.visualTimes || computeVisualTimesSec();
  // Onset ms per selectable
  state.timeline.msBySel = state.selectable.map((_, selIdx) => {
    const v = state.maps.selToVisual[selIdx];
    const sec = (v != null ? visual.times[v] : 0);
    return sec * 1000;
  });
  // Duration (beats) per selectable — sum tie chain if grouped
  state.timeline.metaBySel = state.selectable.map(sel => ({
    durBeats: computeDurBeatsForSelectable(sel)
  }));
  // Reference seconds (if aligned)
  if (state.align?.timeMap) {
    state.timeline.refSecBySel = state.selectable.map((_, selIdx) =>
      mapSelToRefSeconds(selIdx, state.align.timeMap)
    );
  } else {
    state.timeline.refSecBySel = state.selectable.map(() => null);
  }
}

Duration helper (use XML duration/divisions; sum all notes if chain grouped):

function computeDurBeatsForSelectable(sel) {
  let beats = 0;
  const notes = sel.xmlNotes || sel.domNodes || [];
  for (const n of notes) {
    const dur = +(n.querySelector?.('duration')?.textContent || 0);
    const div = +(n.closest?.('measure')?.querySelector('divisions')?.textContent
                  || state.globalDivisions || 1);
    beats += div ? dur/div : 0;
  }
  return beats || 0;
}

Call these:
	•	After OSMD render: state.audio.visualTimes = computeVisualTimesSec(); buildVisualSelMaps(); rebuildTimeline();
	•	After alignment sets state.align.timeMap: rebuildTimeline();

⸻

3) Checkpoint segmentation (rests → windows fallback)

function buildCheckpoints() {
  const S = state.selectable || [];
  const cps = [];
  let start = null, lastNote = null;

  for (let i=0; i<S.length; i++) {
    const it = S[i];
    if (it.type === 'rest') {
      if (start != null && lastNote != null && lastNote >= start) {
        cps.push({ startSel: start, endSel: lastNote });
      }
      start = null; lastNote = null;
      continue;
    }
    if (it.type === 'note') {
      if (start == null) start = i;
      lastNote = i;
    }
  }
  if (start != null && lastNote != null && lastNote >= start) {
    cps.push({ startSel: start, endSel: lastNote });
  }

  if (!cps.length) {
    const WIN = 12; // fallback window size
    for (let i=0; i<S.length; i+=WIN) {
      cps.push({ startSel: i, endSel: Math.min(i+WIN-1, S.length-1) });
    }
  }
  return cps;
}


⸻

4) HUD (simple DOM, no score overlays)

4.1 HTML (place inside .controls under Game Mode toggle)

<div id="gamifyHud" class="gamify-hud" hidden>
  <div class="gamify-row">
    <span id="gmScore"  class="gm-pill">Score: 0</span>
    <span id="gmStreak" class="gm-pill">Streak: 0</span>
    <span id="gmAcc"    class="gm-pill">Accuracy: 0%</span>
    <span id="gmGrade"  class="gm-pill">—</span>
  </div>
  <div class="gamify-row">
    <button id="gmPrev"  type="button">⟵</button>
    <span   id="gmLabel">Checkpoint 1/1</span>
    <button id="gmNext"  type="button">⟶</button>
    <button id="gmRetry" type="button">Retry</button>
  </div>
</div>

4.2 CSS

.gamify-hud { display:flex; flex-direction:column; gap:6px; margin:6px 0; }
.gamify-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.gm-pill    { background:#f3f4f6; border-radius:14px; padding:4px 10px; font-weight:600; }
#gmLabel    { min-width:140px; text-align:center; }
.gamify-hud button { min-height:32px; min-width:40px; }

4.3 Wiring

const hud = {
  root:  document.getElementById('gamifyHud'),
  score: document.getElementById('gmScore'),
  streak:document.getElementById('gmStreak'),
  acc:   document.getElementById('gmAcc'),
  grade: document.getElementById('gmGrade'),
  label: document.getElementById('gmLabel'),
  prev:  document.getElementById('gmPrev'),
  next:  document.getElementById('gmNext'),
  retry: document.getElementById('gmRetry'),
};

function showGamifyHud(show) { hud.root.hidden = !show; }
function gradeFromAccuracy(p) { return p>=98?'S':p>=90?'A':p>=80?'B':p>=70?'C':'D'; }

function updateGamifyHud() {
  const g = state.gameMode.gamify;
  hud.score.textContent  = `Score: ${g.score}`;
  hud.streak.textContent = `Streak: ${g.streak}`;
  const acc = g.total ? Math.round((g.hits/g.total)*100) : 0;
  hud.acc.textContent    = `Accuracy: ${acc}%`;
  hud.grade.textContent  = gradeFromAccuracy(acc);
  const total = g.checkpoints.length || 1;
  hud.label.textContent  = `Checkpoint ${(g.current||0)+1}/${total}`;
}

hud.prev.onclick  = () => gotoCheckpoint(state.gameMode.gamify.current - 1);
hud.next.onclick  = () => gotoCheckpoint(state.gameMode.gamify.current + 1);
hud.retry.onclick = () => retryCheckpoint();


⸻

5) Enter/Exit & navigation

function enterGamify(mode='checkpoint') {
  const g = state.gameMode.gamify;
  g.enabled = true;
  g.mode = mode;
  g.fileKey = `${state.fileHash||'nofile'}|${state.selectable?.length||0}|v1`;
  g.score = 0; g.streak = 0; g.bestStreak = 0; g.hits = 0; g.total = 0;

  g.checkpoints = buildCheckpoints();
  g.current = 0;

  showGamifyHud(true);
  gotoCheckpoint(0);
  updateGamifyHud();
}

function exitGamify() {
  const g = state.gameMode.gamify;
  g.enabled = false;
  showGamifyHud(false);
  // Cleanup loops
  if (window.Tone) { Tone.Transport.loop = false; }
  if (state._refTimeHandler && state.audio?.referenceAudio) {
    state.audio.referenceAudio.removeEventListener('timeupdate', state._refTimeHandler);
    state._refTimeHandler = null;
  }
}

function currentCheckpoint() {
  const g = state.gameMode.gamify;
  return g.checkpoints[g.current] || null;
}

function gotoCheckpoint(i) {
  const g = state.gameMode.gamify;
  if (!g.enabled) return;
  const N = g.checkpoints.length;
  g.current = Math.max(0, Math.min(i, N-1));

  const ck = currentCheckpoint();
  if (ck) { state.index = ck.startSel; applySelectionColor?.({scroll:true}); }

  clampTransportToCheckpoint();
  updateGamifyHud();
}

function retryCheckpoint() {
  const g = state.gameMode.gamify;
  g.streak = 0;
  // Optional: track per-checkpoint solved mapping and reset here
  clampTransportToCheckpoint();
  updateGamifyHud();
}


⸻

6) Loop only the active checkpoint

function beatsToSeconds(beats) {
  const bpm = state.transportBPM || 120;
  return (beats * 60) / bpm;
}
function durationBeatsOfSel(selIdx) {
  return state.timeline.metaBySel?.[selIdx]?.durBeats || 0;
}

function clampTransportToCheckpoint() {
  const ck = currentCheckpoint();
  if (!ck) { if (window.Tone) Tone.Transport.loop = false; return; }

  const startSec = (state.timeline.msBySel[ck.startSel]||0) / 1000;
  const endSec   = (state.timeline.msBySel[ck.endSel]  ||0) / 1000
                 + beatsToSeconds(durationBeatsOfSel(ck.endSel));

  if (window.Tone) {
    Tone.Transport.setLoopPoints(startSec, endSec);
    Tone.Transport.loop = true;
    if (Tone.Transport.state === 'started') {
      const pos = Tone.Transport.seconds;
      if (pos < startSec || pos >= endSec) Tone.Transport.seconds = startSec;
    }
  }
  // Reference audio if aligned
  const a = state.audio?.referenceAudio;
  const sRef = state.timeline.refSecBySel[ck.startSel];
  const eRef = state.timeline.refSecBySel[ck.endSel];
  if (a && typeof sRef === 'number' && typeof eRef === 'number') {
    const endRef = eRef + beatsToSeconds(durationBeatsOfSel(ck.endSel));
    if (state._refTimeHandler) a.removeEventListener('timeupdate', state._refTimeHandler);
    state._refTimeHandler = () => {
      if (a.currentTime >= endRef) {
        a.currentTime = sRef;
        if (a.paused) a.play().catch(()=>{});
      }
    };
    a.addEventListener('timeupdate', state._refTimeHandler);
    if (!a.paused && (a.currentTime < sRef || a.currentTime >= endRef)) a.currentTime = sRef;
  }
}


⸻

7) MIDI scheduling: filter to window (keep your scheduler)

In your existing scheduling loop:

function inActiveWindow(selIdx) {
  if (!state.gameMode?.gamify?.enabled) return true;
  const ck = currentCheckpoint();
  return ck ? selIdx >= ck.startSel && selIdx <= ck.endSel : true;
}

// During scheduling:
for (let selIdx=0; selIdx<state.selectable.length; selIdx++) {
  const sel = state.selectable[selIdx];
  if (sel.type !== 'note') continue;
  if (!inActiveWindow(selIdx)) continue;
  // …schedule as you already do using msBySel[selIdx]…
}
// After scheduling:
clampTransportToCheckpoint();

(Also call clampTransportToCheckpoint() after speed changes.)

⸻

8) Scoring hook (cursor advance → selectable)

Cursor advance (visual → selectable anchor to avoid tie duplicates):

function onCursorAdvanceVisual(visualIdx) {
  const selIdx = state.maps.visualToSel?.[visualIdx];
  if (selIdx == null) return;
  if (visualIdx !== state.maps.selToVisual?.[selIdx]) return; // tie continuation → skip
  onCursorAdvanceSelectable(selIdx);
}

function currentMidiForSel(selIdx) {
  const xmlIdx = state.selectable[selIdx]?.xmlIndex;
  return state.gameMode.currentNoteMidiByXmlIndex.get(xmlIdx);
}
function originalMidiForSel(selIdx) {
  const xmlIdx = state.selectable[selIdx]?.xmlIndex;
  return state.gameMode.originalNoteMidiByXmlIndex.get(xmlIdx);
}

function onCursorAdvanceSelectable(selIdx) {
  if (!state.gameMode?.gamify?.enabled) return;

  const sel = state.selectable[selIdx];
  if (sel?.type !== 'note') return;

  const correct = (currentMidiForSel(selIdx) === originalMidiForSel(selIdx));

  const g = state.gameMode.gamify;
  g.total++;
  if (correct) {
    g.hits++; g.streak++; g.bestStreak = Math.max(g.bestStreak, g.streak);
    g.score += 100 + 10 * Math.min(g.streak, 20);
  } else {
    g.streak = 0;
    g.score = Math.max(0, g.score - 50);
  }

  // Auto-advance at checkpoint boundary
  const ck = currentCheckpoint();
  if (ck && selIdx >= ck.endSel) gotoCheckpoint(g.current + 1);

  updateGamifyHud();
}


⸻

9) Lifecycle wiring (one line each)
	•	After OSMD render:
state.audio.visualTimes = computeVisualTimesSec(); buildVisualSelMaps(); rebuildTimeline();
	•	After alignment completes:
rebuildTimeline(); clampTransportToCheckpoint();
	•	Game Mode toggle:
In enterGameMode() → call enterGamify('checkpoint')
In exitGameMode() → call exitGamify()
	•	Play MIDI: after scheduling → clampTransportToCheckpoint() → Tone.Transport.start()
	•	Play Reference: allowed only if aligned (or show a toast)

⸻

10) Persistence (small & safe)

function saveGamify() {
  const g = state.gameMode.gamify;
  if (!g.fileKey) return;
  const acc = g.total ? g.hits/g.total : 0;
  const key = `gm:${g.fileKey}`;
  const prev = JSON.parse(localStorage.getItem(key) || 'null');
  const curr = { bestScore: g.score, bestStreak: g.bestStreak, bestAcc: acc, lastCheckpoint: g.current };
  if (!prev || curr.bestScore > prev.bestScore) {
    localStorage.setItem(key, JSON.stringify(curr));
  }
}

Call saveGamify() on exit and when finishing last checkpoint.

⸻

11) Cleanup & guards
	•	On exit: Tone.Transport.loop=false; remove reference timeupdate listener.
	•	If no alignment, disable reference loop with a clear message (“Align to use reference in gamify mode”).
	•	If no notes or single checkpoint, still show HUD and loop the window.

⸻

12) Acceptance checklist
	•	HUD shows when Game Mode ON; hides when OFF.
	•	Checkpoints build (rests → 12-note fallback).
	•	MIDI playback loops only the active window; Transport clamps into range.
	•	Reference audio loops when aligned; otherwise disabled with message.
	•	Scoring updates on cursor hits; streak/accuracy/grade reflect play.
	•	Prev/Next/Retry work; auto-advance at window end works.
	•	No leaks: Transport loop off; ref listener removed; no duplicate schedules.
	•	Persistence: best score/streak/accuracy saved per file.

⸻

This plan keeps everything in your selectable/timing/transport world—no OSMD drawing hacks—and gives you a crisp, testable feature slice.

---

## Feedback on Refined Implementation Plan

Your refined plan is excellent - much more concise and production-ready than my verbose version. Key improvements:

### ✅ Strengths

**Streamlined Architecture**: The consolidated data model and lifecycle hooks are much cleaner than my 13-step approach.

**Practical Timeline Building**: Your `computeVisualTimesSec()` with millisecond normalization handles real-world timing edge cases better.

**Smart Checkpoint Logic**: Rest-based segmentation with 12-note fallback covers both phrase-aware and mechanical chunking elegantly.

**Robust Loop Management**: The combined MIDI/reference audio clamping with proper cleanup prevents timing leaks.

**Efficient Scoring**: Visual-to-selectable mapping with tie deduplication avoids double-counting tied notes.

**Clean Integration**: Single-line lifecycle hooks (`enterGameMode() → enterGamify()`) maintain existing patterns.

### 🔧 Minor Implementation Notes

**XML Index Bridge**: The `state.selectable[selIdx]?.xmlIndex` assumption may need verification - some selectables might store XML references differently.

**Duration Calculation**: The `computeDurBeatsForSelectable()` function should handle grace notes and backup/forward elements that might appear in `domNodes`.

**Visual Mapping**: `buildVisualSelMaps()` might need fallback logic if `data-xml-node-index` attributes aren't consistently set.

**Transport BPM**: Ensure `state.transportBPM` is populated from OSMD's tempo markings for accurate beat-to-seconds conversion.

### 🎯 Acceptance Checklist Enhancement

Consider adding:
- **Error Handling**: What happens if no checkpoints are built (empty score)?
- **Speed Integration**: How checkpoint loops respond to speed slider changes
- **Visual Feedback**: Subtle indication of current checkpoint boundaries (optional)

### 📋 Implementation Priority

Your plan is ready for implementation. I'd suggest this order:
1. Data model + timeline building (steps 1-2)
2. HUD + basic navigation (steps 4-5) 
3. Loop constraints (step 6)
4. Scoring integration (step 8)
5. MIDI scheduling + lifecycle (steps 7, 9)

The plan successfully avoids OSMD complexity while delivering a complete gamification experience. The acceptance checklist provides clear success criteria for testing.

