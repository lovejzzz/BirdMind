// Charlie Parker's Mind - Ear Training Game
// Mobile-first game for learning Bird's solos

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const MIDI_RANGE = { min: 48, max: 89 }; // C3 to F6

// Dynamic staff config - will be calculated based on screen width
function getStaffConfig() {
    const fragment = state.currentFragment || [];
    const screenWidth = window.innerWidth;
    const fragmentLength = fragment.length;
    
    // ALWAYS use readable note spacing — staff scrolls horizontally if needed
    const noteSpacing = 65;
    const ls = screenWidth < 768 ? 18 : 18; // lineSpacing — bigger = more readable
    
    return {
        lines: 5,
        lineSpacing: ls,
        topLine: 55,
        leftMargin: 75,
        noteSpacing: noteSpacing,
        clefSize: 80
    };
}

// Legacy constant for backwards compatibility
const STAFF_CONFIG = {
    lines: 5,
    lineSpacing: 16,
    topLine: 70,
    leftMargin: 70,
    noteSpacing: 70,
    clefSize: 80
};

// Chromatic scale with sharp preference (going up)
const CHROMATIC_UP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Chromatic scale with flat preference (going down)
const CHROMATIC_DOWN = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Staff position mapping (MIDI pitch to staff position)
// Middle line (B4) = position 0, spaces are +/-1, lines are +/-2, etc.
const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DIATONIC_STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

// SMuFL (Standard Music Font Layout) glyph constants for Bravura font
const SMUFL = {
    // Clefs
    gClef: '\uE050',           // Treble clef (G clef)
    
    // Noteheads
    noteheadWhole: '\uE0A2',   // Whole note
    noteheadHalf: '\uE0A3',    // Half note
    noteheadBlack: '\uE0A4',   // Quarter/eighth/16th note (filled)
    
    // Flags
    flag8thUp: '\uE240',
    flag8thDown: '\uE241',
    flag16thUp: '\uE242',
    flag16thDown: '\uE243',
    
    // Rests
    restWhole: '\uE4E3',
    restHalf: '\uE4E4',
    restQuarter: '\uE4E5',
    rest8th: '\uE4E6',
    rest16th: '\uE4E7',
    
    // Accidentals
    accidentalSharp: '\uE262',
    accidentalFlat: '\uE260',
    accidentalNatural: '\uE261',
    accidentalDoubleSharp: '\uE263',
    accidentalDoubleFlat: '\uE264',
    
    // Dots
    augmentationDot: '\uE1E7',
    
    // Time signatures
    timeSig0: '\uE080', timeSig1: '\uE081', timeSig2: '\uE082',
    timeSig3: '\uE083', timeSig4: '\uE084', timeSig5: '\uE085',
    timeSig6: '\uE086', timeSig7: '\uE087', timeSig8: '\uE088',
    timeSig9: '\uE089',
};

// ============================================================================
// GLOBAL STATE
// ============================================================================

const state = {
    songs: [],
    currentSong: null,
    currentSongData: null,
    fragments: [],
    currentFragmentIndex: 0,
    currentFragment: null,
    selectedNoteIndex: 0,
    userPitches: [],
    submitted: false,
    pianoSampler: null,
    audioInitialized: false,
    timeMap: null,       // DTW alignment: [{scoreSec, audioSec}]
    audioBuf: null,      // decoded AudioBuffer for alignment
    audioCtx: null,      // AudioContext
    playbackActive: false,
    playbackCursorIndex: -1,
    playbackRAF: null,
    playbackTimeout: null,
    // Scoring & progression
    totalScore: 0,
    streak: 0,
    maxStreak: 0,
    fragmentScores: [],  // Array of {accuracy, stars, score}
    undoStack: [],       // For undo functionality
    wakeLock: null,      // Screen wake lock
    soundEffects: null,  // Tone.js synth for SFX
    // NEW: Game modes
    gameMode: 'normal',  // normal, interval, practice, challenge
    // NEW: Settings
    settings: {
        showNoteNames: true,
        defaultSpeed: 1.0,
        defaultVolume: 1.0,
        showIntervals: true,
        showScaleDegrees: false
    },
    // NEW: Stats & progression
    stats: {
        totalNotes: 0,
        correctNotes: 0,
        songsCompleted: 0,
        totalPlayTime: 0,
        sessionStart: null,
        sessionFragments: 0,
        sessionAccuracy: 0,
        xp: 0,
        level: 1,
        achievements: []
    },
    // NEW: Touch gesture tracking
    touchStart: null,
    touchEnd: null
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function showLoading(text = 'Loading...') {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    loadingText.textContent = text;
    overlay.classList.add('active');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('active');
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

// MIDI pitch to note name (with octave)
function midiToNoteName(midi, preferSharps = true) {
    const octave = Math.floor(midi / 12) - 1;
    const pitchClass = midi % 12;
    const scale = preferSharps ? CHROMATIC_UP : CHROMATIC_DOWN;
    return scale[pitchClass] + octave;
}

// Get pitch class and octave from MIDI
function midiToPitchInfo(midi) {
    const octave = Math.floor(midi / 12) - 1;
    const pitchClass = midi % 12;
    return { pitchClass, octave };
}

// Calculate staff position for a MIDI pitch
// B4 (MIDI 71) is the middle line = position 0
// Each diatonic step is 1 position, C5=1, A4=-1, etc.
function midiToStaffPosition(midi) {
    const { pitchClass, octave } = midiToPitchInfo(midi);
    
    // Find the diatonic step (C=0, D=1, E=2, F=3, G=4, A=5, B=6)
    const diatonicNote = PITCH_CLASSES[pitchClass].charAt(0);
    const diatonicStep = DIATONIC_STEPS.indexOf(diatonicNote);
    
    // B4 is position 0, B4 = octave 4, diatonic step 6
    // Formula: (octave - 4) * 7 + (diatonicStep - 6)
    return (octave - 4) * 7 + (diatonicStep - 6);
}

// Check if a pitch needs an accidental (sharp or flat)
function needsAccidental(midi) {
    const pitchClass = midi % 12;
    // Black keys: 1(C#/Db), 3(D#/Eb), 6(F#/Gb), 8(G#/Ab), 10(A#/Bb)
    return [1, 3, 6, 8, 10].includes(pitchClass);
}

// Get accidental symbol for a pitch
function getAccidental(midi, preferSharps = true) {
    if (!needsAccidental(midi)) return '';
    const pitchClass = midi % 12;
    const scale = preferSharps ? CHROMATIC_UP : CHROMATIC_DOWN;
    const noteName = scale[pitchClass];
    return noteName.includes('#') ? '♯' : '♭';
}

// ============================================================================
// NEW: INTERVAL & MUSIC THEORY HELPERS
// ============================================================================

const INTERVAL_NAMES = ['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7', 'P8'];

function getIntervalName(semitones, direction = 1) {
    const absSemitones = Math.abs(semitones);
    const octaves = Math.floor(absSemitones / 12);
    const remainder = absSemitones % 12;
    const arrow = semitones > 0 ? '↑' : semitones < 0 ? '↓' : '';
    const intervalName = INTERVAL_NAMES[remainder] || 'P1';
    return octaves > 0 ? `${intervalName}+${octaves}${arrow}` : `${intervalName}${arrow}`;
}

function calculateInterval(midi1, midi2) {
    return midi2 - midi1;
}

function getScaleDegree(midi, tonicMidi) {
    const semitones = ((midi - tonicMidi) % 12 + 12) % 12;
    const degreeMap = {
        0: '1', 1: '♭2', 2: '2', 3: '♭3', 4: '3', 5: '4',
        6: '♯4/♭5', 7: '5', 8: '♭6', 9: '6', 10: '♭7', 11: '7'
    };
    return degreeMap[semitones] || '?';
}

// ============================================================================
// NEW: SETTINGS & STATS PERSISTENCE
// ============================================================================

function loadSettings() {
    try {
        const data = localStorage.getItem('cpm_settings');
        if (data) {
            const saved = JSON.parse(data);
            state.settings = { ...state.settings, ...saved };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem('cpm_settings', JSON.stringify(state.settings));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

function loadStats() {
    try {
        const data = localStorage.getItem('cpm_stats');
        if (data) {
            const saved = JSON.parse(data);
            state.stats = { ...state.stats, ...saved };
        }
    } catch (e) {
        console.error('Failed to load stats:', e);
    }
}

function saveStats() {
    try {
        localStorage.setItem('cpm_stats', JSON.stringify(state.stats));
    } catch (e) {
        console.error('Failed to save stats:', e);
    }
}

function addXP(amount) {
    state.stats.xp += amount;
    const xpForNextLevel = state.stats.level * 100;
    if (state.stats.xp >= xpForNextLevel) {
        state.stats.level++;
        showLevelUp();
    }
    saveStats();
}

function unlockAchievement(id, name, desc) {
    if (!state.stats.achievements.includes(id)) {
        state.stats.achievements.push(id);
        showAchievement(name, desc);
        saveStats();
    }
}

function showAchievement(name, desc) {
    const toast = document.createElement('div');
    toast.className = 'achievement-toast';
    toast.innerHTML = `
        <div class="achievement-icon">🏆</div>
        <div class="achievement-content">
            <div class="achievement-name">${name}</div>
            <div class="achievement-desc">${desc}</div>
        </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showLevelUp() {
    const toast = document.createElement('div');
    toast.className = 'level-up-toast';
    toast.textContent = `LEVEL ${state.stats.level}!`;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    playSFX('perfect');
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// ============================================================================
// SALAMANDER PIANO SETUP
// ============================================================================

async function initializePiano() {
    if (state.pianoSampler) return;
    
    // Build the sample map for Salamander piano
    const samples = {};
    const notes = ['C', 'Ds', 'Fs', 'A'];
    const octaves = {
        'C': [1, 2, 3, 4, 5, 6, 7, 8],
        'Ds': [1, 2, 3, 4, 5, 6, 7],
        'Fs': [1, 2, 3, 4, 5, 6, 7],
        'A': [0, 1, 2, 3, 4, 5, 6, 7]
    };
    
    notes.forEach(note => {
        octaves[note].forEach(octave => {
            const noteName = note + octave;
            samples[noteName] = `./assets/salamander/${noteName}.mp3`;
        });
    });
    
    state.pianoSampler = new Tone.Sampler({
        urls: samples,
        baseUrl: "",
        onload: () => {
            console.log('Piano samples loaded');
        }
    }).toDestination();
    
    // Initialize sound effects synth
    state.soundEffects = new Tone.Synth({
        oscillator: { type: 'square' },
        envelope: { attack: 0.005, decay: 0.05, sustain: 0, release: 0.05 }
    }).toDestination();
}

function playPreviewNote(midi) {
    if (!state.pianoSampler || !state.audioInitialized) return;
    
    const noteName = midiToNoteName(midi, true);
    state.pianoSampler.triggerAttackRelease(noteName, "8n");
}

// Sound effects
function playSFX(type) {
    if (!state.soundEffects || !state.audioInitialized) return;
    
    if (type === 'correct') {
        state.soundEffects.triggerAttackRelease('C6', '0.08');
    } else if (type === 'incorrect') {
        state.soundEffects.triggerAttackRelease('C3', '0.12');
    } else if (type === 'perfect') {
        // Arpeggio for perfect fragment
        setTimeout(() => state.soundEffects.triggerAttackRelease('C6', '0.05'), 0);
        setTimeout(() => state.soundEffects.triggerAttackRelease('E6', '0.05'), 50);
        setTimeout(() => state.soundEffects.triggerAttackRelease('G6', '0.05'), 100);
        setTimeout(() => state.soundEffects.triggerAttackRelease('C7', '0.08'), 150);
    }
}

// Haptic feedback
function haptic(duration = 10) {
    if (navigator.vibrate) {
        navigator.vibrate(duration);
    }
}

// ============================================================================
// LOCAL STORAGE & SCORING
// ============================================================================

function loadSongStats(songName) {
    try {
        const key = `cpm_${songName}`;
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : { bestScore: 0, stars: 0, attempts: 0 };
    } catch (e) {
        return { bestScore: 0, stars: 0, attempts: 0 };
    }
}

function saveSongStats(songName, stats) {
    try {
        const key = `cpm_${songName}`;
        const existing = loadSongStats(songName);
        const updated = {
            bestScore: Math.max(existing.bestScore, stats.score || 0),
            stars: Math.max(existing.stars, stats.stars || 0),
            attempts: (existing.attempts || 0) + 1
        };
        localStorage.setItem(key, JSON.stringify(updated));
    } catch (e) {
        console.error('Failed to save stats:', e);
    }
}

function calculateDifficulty(song) {
    // Simple heuristic based on song name length for now
    // Can be enhanced by analyzing fragment data
    const hash = song.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return 1 + (hash % 3); // 1-3 difficulty
}

// ============================================================================
// SONG DISCOVERY
// ============================================================================

async function discoverSongs() {
    showLoading('Discovering songs...');
    
    // List of known Charlie Parker tunes (must match Songs/ folder names exactly)
    const songNames = [
        "An Oscar For Treadwell", "Another Hairdo", "Anthropology", "Au Private 1",
        "Au Private 2", "Back Home Blues", "Barbados", "Billies's Bounce",
        "Bird Gets The Worm", "Bloomdido", "Blue Bird", "Blues For Alice",
        "Buzzy", "Card Board", "Celerity", "Chasing The Bird", "Cheryl",
        "Chi Chi", "Confirmation", "Cosmic Rays", "Dewey Square", "Diverse",
        "Donna Lee", "KC Blues", "Kim 1", "Kim 2", "Ko Ko", "Laird Baird",
        "Marmaduke", "Mohawk 1", "Mohawk 2", "Moose The Mooche",
        "My Little Suede Shoes", "Now's The Time 1", "Now's The Time 2",
        "Ornithology", "Passport", "Perhaps", "Red Cross", "Relaxing With Lee",
        "Scrapple From The Apple", "Segment", "Shawnuff", "Si Si",
        "Steeplechase", "The Bird", "Thriving From A Riff", "Visa",
        "Warming Up A Riff", "Yardbird Suite"
    ];
    
    state.songs = songNames.map(name => ({
        name: name,
        xmlPath: `./Songs/${name}/${name}.xml`,
        audioPath: `./Songs/${name}/${name}.mp3`
    }));
    
    hideLoading();
}

// ============================================================================
// MUSICXML PARSING
// ============================================================================

// PRIORITY 5.22: Error recovery for song loading
async function loadSongXML(song) {
    showLoading(`Loading ${song.name}...`);
    
    try {
        const response = await fetch(song.xmlPath);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const xmlText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        
        // Check for XML parse errors
        const parserError = xmlDoc.querySelector('parsererror');
        if (parserError) {
            throw new Error('XML parsing failed');
        }
        
        // Store raw XML and parsed doc for OSMD
        state.rawXML = xmlText;
        state.xmlDoc = xmlDoc;
        
        const songData = parseMusicXML(xmlDoc);
        if (!songData || !songData.notes || songData.notes.length === 0) {
            throw new Error('No valid notes found in score');
        }
        
        state.currentSongData = songData;
        state.currentSong = song;
        
        // Split into fragments
        state.fragments = extractFragments(songData);
        if (state.fragments.length === 0) {
            throw new Error('No fragments could be extracted');
        }
        state.currentFragmentIndex = 0;
        
        hideLoading();
        return songData;
    } catch (error) {
        console.error('Error loading song:', error);
        hideLoading();
        alert(`Failed to load "${song.name}".\n\n${error.message}\n\nPlease try another song.`);
        return null;
    }
}

function parseMusicXML(xmlDoc) {
    const songData = {
        title: '',
        divisions: 120,
        tempo: 120,
        timeSignature: { beats: 4, beatType: 4 },
        notes: []
    };
    
    // Get title
    const titleEl = xmlDoc.querySelector('work-title');
    if (titleEl) songData.title = titleEl.textContent;
    
    // Get divisions (ticks per quarter note)
    const divisionsEl = xmlDoc.querySelector('divisions');
    if (divisionsEl) songData.divisions = parseInt(divisionsEl.textContent);
    
    // Get tempo
    const tempoEl = xmlDoc.querySelector('sound[tempo]');
    if (tempoEl) songData.tempo = parseFloat(tempoEl.getAttribute('tempo'));
    
    // Get time signature
    const beatsEl = xmlDoc.querySelector('time beats');
    const beatTypeEl = xmlDoc.querySelector('time beat-type');
    if (beatsEl && beatTypeEl) {
        songData.timeSignature.beats = parseInt(beatsEl.textContent);
        songData.timeSignature.beatType = parseInt(beatTypeEl.textContent);
    }
    
    // Get key signature
    const fifthsEl = xmlDoc.querySelector('key fifths');
    if (fifthsEl) {
        songData.keySignature = { fifths: parseInt(fifthsEl.textContent) };
    }
    
    // Parse all notes, tracking cumulative position in divisions
    let cumulativeDiv = 0;
    const measures = xmlDoc.querySelectorAll('measure');
    let measureIndex = 0;
    measures.forEach(measure => {
        // Check for divisions change mid-score
        const divEl = measure.querySelector('divisions');
        if (divEl) songData.divisions = parseInt(divEl.textContent);
        
        const noteElements = measure.querySelectorAll('note');
        noteElements.forEach(noteEl => {
            const note = parseNote(noteEl, songData.divisions);
            if (note) {
                note.startDiv = cumulativeDiv;
                note.measureIndex = measureIndex;
                cumulativeDiv += note.duration;
                songData.notes.push(note);
            }
        });
        measureIndex++;
    });
    
    return songData;
}

function parseNote(noteEl, divisions) {
    const note = {
        isRest: false,
        midi: 60,
        duration: 0,
        type: 'quarter',
        tied: false
    };
    
    // Check if rest
    const restEl = noteEl.querySelector('rest');
    note.isRest = !!restEl;
    
    // Get duration
    const durationEl = noteEl.querySelector('duration');
    if (durationEl) note.duration = parseInt(durationEl.textContent);
    
    // Get note type
    const typeEl = noteEl.querySelector('type');
    if (typeEl) note.type = typeEl.textContent;
    
    // Check for dot
    note.dotted = noteEl.querySelector('dot') !== null;
    
    // Get pitch (if not a rest)
    if (!note.isRest) {
        const pitchEl = noteEl.querySelector('pitch');
        if (pitchEl) {
            const step = pitchEl.querySelector('step').textContent;
            const octave = parseInt(pitchEl.querySelector('octave').textContent);
            const alterEl = pitchEl.querySelector('alter');
            const alter = alterEl ? parseInt(alterEl.textContent) : 0;
            
            note.midi = pitchToMidi(step, octave, alter);
        }
    }
    
    // Check for ties (both start and stop for rendering)
    const tieEls = noteEl.querySelectorAll('tie');
    note.tieStart = false;
    note.tieStop = false;
    tieEls.forEach(t => {
        if (t.getAttribute('type') === 'start') note.tieStart = true;
        if (t.getAttribute('type') === 'stop') note.tieStop = true;
    });
    // Keep legacy `tied` property for backwards compatibility
    note.tied = note.tieStart;
    
    return note;
}

function pitchToMidi(step, octave, alter = 0) {
    const stepValues = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 };
    const pitchClass = stepValues[step] + alter;
    return (octave + 1) * 12 + pitchClass;
}

// ============================================================================
// FRAGMENT EXTRACTION
// ============================================================================

function extractFragments(songData) {
    const { divisions, tempo } = songData;
    const secPerDiv = 60 / tempo / divisions;
    const fragments = [];
    let currentFragment = [];
    let cumulativeDiv = 0; // track position in divisions for timing
    
    // Group tied notes and track timing
    const processedNotes = [];
    for (let i = 0; i < songData.notes.length; i++) {
        const note = songData.notes[i];
        
        if (note.isRest) {
            processedNotes.push({ ...note, startDiv: cumulativeDiv });
            cumulativeDiv += note.duration;
            continue;
        }
        
        // If this note is tied to the next, combine durations
        if (note.tied) {
            let combinedDuration = note.duration;
            const startDiv = cumulativeDiv;
            cumulativeDiv += note.duration;
            let j = i + 1;
            
            // Look ahead for tied notes
            while (j < songData.notes.length && songData.notes[j].tied) {
                combinedDuration += songData.notes[j].duration;
                cumulativeDiv += songData.notes[j].duration;
                j++;
            }
            
            // Add the final tied note's duration
            if (j < songData.notes.length && !songData.notes[j].isRest) {
                combinedDuration += songData.notes[j].duration;
                cumulativeDiv += songData.notes[j].duration;
            }
            
            processedNotes.push({
                ...note,
                duration: combinedDuration,
                startDiv: startDiv,
                tied: false
            });
            
            i = j; // Skip the tied notes we've already processed
        } else {
            processedNotes.push({ ...note, startDiv: cumulativeDiv });
            cumulativeDiv += note.duration;
        }
    }
    
    // Split at rests
    for (const note of processedNotes) {
        if (note.isRest) {
            if (currentFragment.length > 0) {
                fragments.push([...currentFragment]);
                currentFragment = [];
            }
        } else {
            currentFragment.push(note);
        }
    }
    
    // Add final fragment if any
    if (currentFragment.length > 0) {
        fragments.push(currentFragment);
    }
    
    // Filter out very short fragments (less than 2 notes)
    const filtered = fragments.filter(f => f.length >= 2);
    
    // Split long fragments into chunks of MAX_FRAGMENT_SIZE for phone playability
    const MAX_FRAGMENT_SIZE = 16;
    const result = [];
    for (const frag of filtered) {
        if (frag.length <= MAX_FRAGMENT_SIZE) {
            result.push(frag);
        } else {
            for (let i = 0; i < frag.length; i += MAX_FRAGMENT_SIZE) {
                const chunk = frag.slice(i, i + MAX_FRAGMENT_SIZE);
                if (chunk.length >= 2) result.push(chunk);
            }
        }
    }
    return result;
}

// ============================================================================
// DTW AUDIO-SCORE ALIGNMENT (ported from main app)
// ============================================================================

// Resample audio buffer to mono at target sample rate
async function resampleBuffer(buf, targetSr) {
    if (buf.sampleRate === targetSr && buf.numberOfChannels === 1) return buf;
    const length = Math.floor(buf.duration * targetSr);
    const ctx = new OfflineAudioContext(1, length, targetSr);
    const src = ctx.createBufferSource();
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

// Build score chroma (12 pitch-class bins) from parsed song data
function buildScoreChroma(songData, hopSec = 0.046) {
    const { divisions, tempo, notes } = songData;
    const secPerDiv = 60 / tempo / divisions;
    const scoreNotes = notes
        .filter(n => !n.isRest && typeof n.midi === 'number')
        .map(n => ({
            midi: n.midi,
            startSec: (n.startDiv || 0) * secPerDiv,
            endSec: ((n.startDiv || 0) + n.duration) * secPerDiv
        }));
    const totalSec = scoreNotes.length ? Math.max(...scoreNotes.map(n => n.endSec)) : 0;
    const T = Math.max(1, Math.ceil(totalSec / hopSec));
    const X = Array.from({ length: T }, () => new Float32Array(12).fill(0));
    for (const n of scoreNotes) {
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

// Goertzel-based audio chroma (12 bins summed across octaves)
async function buildAudioChroma(audioBuf, hopSec = 0.046, winSec = 0.092) {
    const targetSr = 22050;
    const buf = await resampleBuffer(audioBuf, targetSr);
    const ch = buf.getChannelData(0);
    const hop = Math.max(1, Math.floor(hopSec * targetSr));
    const win = Math.max(hop, Math.floor(winSec * targetSr));
    const hann = new Float32Array(win);
    for (let i = 0; i < win; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (win - 1)));

    const minMidi = 48, maxMidi = 84;
    const midiList = []; for (let m = minMidi; m <= maxMidi; m++) midiList.push(m);
    const twoPi = 2 * Math.PI;

    function goertzel(frame, freq) {
        const w = twoPi * freq / targetSr;
        const cosw = Math.cos(w), sinw = Math.sin(w);
        let s0 = 0, s1 = 0, s2 = 0;
        for (let n = 0; n < frame.length; n++) {
            s0 = frame[n] + 2 * cosw * s1 - s2;
            s2 = s1; s1 = s0;
        }
        const re = s1 - s2 * cosw;
        const im = s2 * sinw;
        return re * re + im * im;
    }

    const frames = Math.max(1, Math.floor((ch.length - win) / hop));
    const Y = Array.from({ length: frames }, () => new Float32Array(12).fill(0));
    const frame = new Float32Array(win);

    for (let f = 0, pos = 0; f < frames; f++, pos += hop) {
        for (let i = 0; i < win; i++) frame[i] = (ch[pos + i] || 0) * hann[i];
        for (let midi of midiList) {
            const freq = 440 * Math.pow(2, (midi - 69) / 12);
            const pwr = goertzel(frame, freq);
            Y[f][midi % 12] += pwr;
        }
        let s = 0; for (let i = 0; i < 12; i++) s += Y[f][i] * Y[f][i];
        s = Math.sqrt(s) || 1;
        for (let i = 0; i < 12; i++) Y[f][i] /= s;
    }
    return { chroma: Y, hopSec: hop / targetSr };
}

// Subsequence DTW with cosine distance
function dtwSubsequence(X, Y, hopX, hopY) {
    const n = X.length, m = Y.length;
    const INF = 1e15;
    const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
    const P = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    D[0].fill(0);
    const cosDist = (a, b) => { let s = 0; for (let i = 0; i < 12; i++) s += a[i] * b[i]; return 1 - s; };
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const c = cosDist(X[i - 1], Y[j - 1]);
            let best = D[i - 1][j - 1], dir = 1;
            if (D[i - 1][j] < best) { best = D[i - 1][j]; dir = 2; }
            if (D[i][j - 1] < best) { best = D[i][j - 1]; dir = 3; }
            D[i][j] = c + best; P[i][j] = dir;
        }
    }
    let jStar = 1, best = D[n][1];
    for (let j = 2; j <= m; j++) if (D[n][j] < best) { best = D[n][j]; jStar = j; }
    const path = [];
    let i = n, j = jStar;
    while (i > 0 && j > 0) {
        path.push([i - 1, j - 1]);
        const d = P[i][j];
        if (d === 1) { i--; j--; } else if (d === 2) { i--; } else { j--; }
    }
    path.reverse();
    return path.map(([ii, jj]) => ({ scoreSec: ii * hopX, audioSec: jj * hopY }));
}

function rotate12(frame, k) {
    const out = new Float32Array(12);
    for (let i = 0; i < 12; i++) out[i] = frame[(i - k + 12) % 12];
    return out;
}

// Perform DTW alignment between score and audio
async function performAlignment(songData, audioBuf) {
    const X = buildScoreChroma(songData);
    const Y = await buildAudioChroma(audioBuf);
    let bestMap = null, bestScore = -Infinity;
    for (let k = 0; k < 12; k++) {
        const Xk = X.chroma.map(fr => rotate12(fr, k));
        const map = dtwSubsequence(Xk, Y.chroma, X.hopSec, Y.hopSec);
        if (map.length > bestScore) { bestScore = map.length; bestMap = map; }
    }
    return bestMap; // array of { scoreSec, audioSec }
}

// Map audio time to score time using the alignment timeMap
function mapAudioToScore(timeMap, audioTime) {
    if (!timeMap || !timeMap.length) return audioTime;
    let lo = 0, hi = timeMap.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (timeMap[mid].audioSec < audioTime) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(1, lo);
    const a0 = timeMap[i - 1], a1 = timeMap[i] || a0;
    const r = (audioTime - a0.audioSec) / Math.max(1e-6, a1.audioSec - a0.audioSec);
    return a0.scoreSec + r * (a1.scoreSec - a0.scoreSec);
}

// Map score time to audio time (reverse lookup)
function mapScoreToAudio(timeMap, scoreSec) {
    if (!timeMap || !timeMap.length) return scoreSec;
    let lo = 0, hi = timeMap.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (timeMap[mid].scoreSec < scoreSec) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(1, lo);
    const a0 = timeMap[i - 1], a1 = timeMap[i] || a0;
    const r = (scoreSec - a0.scoreSec) / Math.max(1e-6, a1.scoreSec - a0.scoreSec);
    return a0.audioSec + r * (a1.audioSec - a0.audioSec);
}

// ============================================================================
// AUDIO PLAYBACK
// ============================================================================

function calculateFragmentTiming(fragment, songData) {
    const { divisions, tempo } = songData;
    const secPerDiv = 60 / tempo / divisions;
    
    // Use pre-computed startDiv from fragment extraction
    const startTime = (fragment[0].startDiv || 0) * secPerDiv;
    const duration = fragment.reduce((sum, note) => sum + note.duration, 0) * secPerDiv;
    
    return { startTime, duration };
}

function playFragmentAudio() {
    const audio = document.getElementById('reference-audio');
    const fragment = state.currentFragment;
    const songData = state.currentSongData;
    
    if (!fragment || !songData) return;
    
    // Stop any existing playback cursor
    stopPlaybackCursor();
    
    const timing = calculateFragmentTiming(fragment, songData);
    const { divisions, tempo } = songData;
    const secPerDiv = 60 / tempo / divisions;
    const timeMap = state.timeMap;
    
    // Compute score-time for each note boundary
    const noteScoreTimes = fragment.map(note => {
        const start = (note.startDiv || 0) * secPerDiv;
        const end = start + note.duration * secPerDiv;
        return { start, end };
    });
    
    // Use timeMap to find audio start/end for this fragment
    const fragmentScoreStart = noteScoreTimes[0].start;
    const fragmentScoreEnd = noteScoreTimes[noteScoreTimes.length - 1].end;
    
    let audioStart, audioEnd;
    if (timeMap && timeMap.length) {
        audioStart = mapScoreToAudio(timeMap, fragmentScoreStart);
        audioEnd = mapScoreToAudio(timeMap, fragmentScoreEnd);
    } else {
        // Fallback to tempo-based
        audioStart = fragmentScoreStart;
        audioEnd = fragmentScoreEnd;
    }
    
    audio.currentTime = audioStart;
    audio.play().catch(err => {
        console.error('Audio playback error:', err);
    });
    
    // Start synced cursor
    state.playbackActive = true;
    state.playbackCursorIndex = -1;
    
    function cursorTick() {
        if (!state.playbackActive) return;
        
        const audioTime = audio.currentTime;
        
        // Convert audio time to score time
        let scoreSec;
        if (timeMap && timeMap.length) {
            scoreSec = mapAudioToScore(timeMap, audioTime);
        } else {
            scoreSec = audioTime; // fallback
        }
        
        // Find which note we're on based on score time
        let newIdx = -1;
        for (let i = 0; i < noteScoreTimes.length; i++) {
            if (scoreSec >= noteScoreTimes[i].start && scoreSec < noteScoreTimes[i].end) {
                newIdx = i;
                break;
            }
        }
        
        // Update cursor highlight if changed
        if (newIdx !== state.playbackCursorIndex && newIdx >= 0) {
            state.playbackCursorIndex = newIdx;
            updatePlayhead();
            // Auto-scroll to playhead position
            const container = document.querySelector('.staff-container');
            if (container && state.notePositions && state.notePositions[newIdx] != null) {
                const targetScroll = state.notePositions[newIdx] - container.clientWidth / 2;
                container.scrollTo({ left: Math.max(0, targetScroll), behavior: 'smooth' });
            }
        }
        
        // Check if we've passed the end
        if (audioTime >= audioEnd + 0.3) {
            audio.pause();
            stopPlaybackCursor();
            return;
        }
        
        state.playbackRAF = requestAnimationFrame(cursorTick);
    }
    
    state.playbackRAF = requestAnimationFrame(cursorTick);
    
    // Safety stop
    const estimatedDuration = audioEnd - audioStart;
    state.playbackTimeout = setTimeout(() => {
        audio.pause();
        stopPlaybackCursor();
    }, (estimatedDuration + 1) * 1000);
}

function updatePlayhead() {
    const svg = document.getElementById('staff-svg');
    if (!svg || !state.notePositions) return;
    
    // Remove old playhead
    const old = svg.querySelector('#playhead-line');
    if (old) old.remove();
    const oldGlow = svg.querySelector('#playhead-glow');
    if (oldGlow) oldGlow.remove();
    
    const idx = state.playbackCursorIndex;
    if (idx < 0 || idx >= state.notePositions.length) return;
    
    const x = state.notePositions[idx];
    const config = getStaffConfig();
    const topLine = config.topLine;
    const bottomLine = topLine + (config.lines - 1) * config.lineSpacing;
    
    // Glow background
    svg.appendChild(createSVGElement('rect', {
        id: 'playhead-glow',
        x: x - 15,
        y: topLine - 5,
        width: 30,
        height: bottomLine - topLine + 10,
        fill: 'var(--fg)',
        opacity: 0.08,
        rx: 3
    }));
    
    // Playhead line
    svg.appendChild(createSVGElement('line', {
        id: 'playhead-line',
        x1: x, y1: topLine - 8,
        x2: x, y2: bottomLine + 8,
        stroke: 'white',
        'stroke-width': 2.5,
        opacity: 0.9,
        'stroke-linecap': 'round'
    }));
}

function stopPlaybackCursor() {
    state.playbackActive = false;
    state.playbackCursorIndex = -1;
    if (state.playbackRAF) {
        cancelAnimationFrame(state.playbackRAF);
        state.playbackRAF = null;
    }
    if (state.playbackTimeout) {
        clearTimeout(state.playbackTimeout);
        state.playbackTimeout = null;
    }
    // Remove playhead elements
    const svg = document.getElementById('staff-svg');
    if (svg) {
        const ph = svg.querySelector('#playhead-line');
        if (ph) ph.remove();
        const glow = svg.querySelector('#playhead-glow');
        if (glow) glow.remove();
    }
}

// ============================================================================
// SVG STAFF RENDERING — Professional Music Notation
// ============================================================================

// Treble clef SVG path (scaled for staff)
const TREBLE_CLEF_PATH = 'M 12 40 C 12 40 14 28 14 20 C 14 12 10 6 6 6 C 2 6 0 10 0 14 C 0 20 6 24 10 24 C 14 24 16 20 16 16 C 16 10 12 0 12 -10 C 12 -16 14 -20 14 -20 C 14 -20 16 -16 16 -10 C 16 -2 12 8 12 8 C 12 8 18 14 18 22 C 18 30 14 36 8 38 C 4 40 0 38 0 34 C 0 30 4 28 6 28 C 8 28 10 30 10 32 C 10 34 8 36 6 36 C 8 38 12 36 12 32 C 12 28 8 26 4 26 C -2 26 -4 32 -4 36 C -4 42 2 46 8 46 C 16 46 22 38 22 28 C 22 16 12 10 12 10 L 12 40 Z';

// Draw rest symbol based on duration using SMuFL glyphs
function drawRest(svg, x, topLine, lineSpacing, duration, divisions) {
    const quarterDur = divisions;
    let glyph, yOffset;
    
    if (duration >= quarterDur * 4) {
        glyph = SMUFL.restWhole;
        yOffset = lineSpacing * 1; // Hangs from line 2
    } else if (duration >= quarterDur * 2) {
        glyph = SMUFL.restHalf;
        yOffset = lineSpacing * 2; // Sits on line 3
    } else if (duration >= quarterDur) {
        glyph = SMUFL.restQuarter;
        yOffset = lineSpacing * 2; // Centered on staff
    } else if (duration >= quarterDur / 2) {
        glyph = SMUFL.rest8th;
        yOffset = lineSpacing * 2;
    } else {
        glyph = SMUFL.rest16th;
        yOffset = lineSpacing * 1.5;
    }
    
    const fontSize = 36;
    const text = createSVGElement('text', {
        x: x,
        y: topLine + yOffset + fontSize * 0.1,
        'font-size': fontSize,
        'font-family': 'Bravura',
        fill: 'var(--fg)',
        'text-anchor': 'middle'
    });
    text.textContent = glyph;
    svg.appendChild(text);
}

// ============================================================================
// OSMD FRAGMENT XML BUILDER
// ============================================================================

function buildFragmentXML(fragment, xmlDoc, timeSig, keySig, divisions) {
    if (!fragment || fragment.length === 0 || !xmlDoc) {
        return null;
    }
    
    // Get unique measure indices from fragment
    const measureIndices = [...new Set(fragment.map(n => n.measureIndex || 0))];
    measureIndices.sort((a, b) => a - b);
    
    // Clone the measures we need
    const allMeasures = xmlDoc.querySelectorAll('measure');
    const fragmentMeasures = measureIndices.map(idx => {
        if (idx < allMeasures.length) {
            return allMeasures[idx].cloneNode(true);
        }
        return null;
    }).filter(m => m !== null);
    
    if (fragmentMeasures.length === 0) {
        return null;
    }
    
    // Build minimal MusicXML document
    const showRealPitch = state.submitted || state.showingAnswer;
    
    // If rhythm mode (not showing answer), blank all pitches to B4
    if (!showRealPitch) {
        fragmentMeasures.forEach(measure => {
            const notes = measure.querySelectorAll('note');
            notes.forEach(noteEl => {
                const pitchEl = noteEl.querySelector('pitch');
                if (pitchEl) {
                    // Replace with B4
                    pitchEl.innerHTML = '<step>B</step><octave>4</octave>';
                }
            });
        });
    } else {
        // In answer mode, replace with user pitches
        let noteIndex = 0;
        fragmentMeasures.forEach(measure => {
            const notes = measure.querySelectorAll('note');
            notes.forEach(noteEl => {
                const pitchEl = noteEl.querySelector('pitch');
                if (pitchEl && noteIndex < state.userPitches.length) {
                    const userMidi = state.userPitches[noteIndex];
                    const octave = Math.floor(userMidi / 12) - 1;
                    const pitchClass = userMidi % 12;
                    const stepMap = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
                    const alterMap = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
                    const step = stepMap[pitchClass];
                    const alter = alterMap[pitchClass];
                    
                    let pitchHTML = `<step>${step}</step><octave>${octave}</octave>`;
                    if (alter !== 0) {
                        pitchHTML += `<alter>${alter}</alter>`;
                    }
                    pitchEl.innerHTML = pitchHTML;
                    noteIndex++;
                }
            });
        });
    }
    
    // Ensure first measure has attributes (divisions, key, time, clef)
    const firstMeasure = fragmentMeasures[0];
    let attributesEl = firstMeasure.querySelector('attributes');
    if (!attributesEl) {
        attributesEl = xmlDoc.createElementNS(null, 'attributes');
        firstMeasure.insertBefore(attributesEl, firstMeasure.firstChild);
    }
    
    // Ensure divisions
    let divisionsEl = attributesEl.querySelector('divisions');
    if (!divisionsEl) {
        divisionsEl = xmlDoc.createElementNS(null, 'divisions');
        divisionsEl.textContent = divisions.toString();
        attributesEl.appendChild(divisionsEl);
    }
    
    // Ensure key signature
    let keyEl = attributesEl.querySelector('key');
    if (!keyEl && keySig) {
        keyEl = xmlDoc.createElementNS(null, 'key');
        const fifthsEl = xmlDoc.createElementNS(null, 'fifths');
        fifthsEl.textContent = (keySig.fifths || 0).toString();
        keyEl.appendChild(fifthsEl);
        attributesEl.appendChild(keyEl);
    }
    
    // Ensure time signature
    let timeEl = attributesEl.querySelector('time');
    if (!timeEl && timeSig) {
        timeEl = xmlDoc.createElementNS(null, 'time');
        const beatsEl = xmlDoc.createElementNS(null, 'beats');
        beatsEl.textContent = (timeSig.beats || 4).toString();
        const beatTypeEl = xmlDoc.createElementNS(null, 'beat-type');
        beatTypeEl.textContent = (timeSig.beatType || 4).toString();
        timeEl.appendChild(beatsEl);
        timeEl.appendChild(beatTypeEl);
        attributesEl.appendChild(timeEl);
    }
    
    // Ensure clef
    let clefEl = attributesEl.querySelector('clef');
    if (!clefEl) {
        clefEl = xmlDoc.createElementNS(null, 'clef');
        const signEl = xmlDoc.createElementNS(null, 'sign');
        signEl.textContent = 'G';
        const lineEl = xmlDoc.createElementNS(null, 'line');
        lineEl.textContent = '2';
        clefEl.appendChild(signEl);
        clefEl.appendChild(lineEl);
        attributesEl.appendChild(clefEl);
    }
    
    // Build minimal MusicXML structure
    const xmlString = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Fragment</part-name>
    </score-part>
  </part-list>
  <part id="P1">
    ${fragmentMeasures.map((m, i) => {
        const serializer = new XMLSerializer();
        let measureXML = serializer.serializeToString(m);
        // Fix measure number
        measureXML = measureXML.replace(/number="\d+"/, `number="${i + 1}"`);
        return measureXML;
    }).join('\n')}
  </part>
</score-partwise>`;
    
    return xmlString;
}

// ============================================================================
// OSMD STAFF RENDERING
// ============================================================================

function renderStaff() {
    const container = document.getElementById('staff-svg');
    container.innerHTML = '';
    
    // OSMD needs a visible container with width > 0
    // If container has no width yet (screen not shown), defer rendering
    if (container.clientWidth === 0) {
        setTimeout(() => renderStaff(), 500);
        return;
    }
    
    const fragment = state.currentFragment;
    if (!fragment || fragment.length === 0) return;
    
    const divisions = state.currentSongData?.divisions || 120;
    const timeSig = state.currentSongData?.timeSignature || { beats: 4, beatType: 4 };
    const keySig = state.currentSongData?.keySignature || { fifths: 0 };
    const xmlDoc = state.xmlDoc;
    
    if (!xmlDoc) {
        console.error('No XML document available for OSMD rendering');
        return;
    }
    
    // Build fragment XML
    const fragmentXML = buildFragmentXML(fragment, xmlDoc, timeSig, keySig, divisions);
    if (!fragmentXML) {
        console.error('Failed to build fragment XML');
        return;
    }
    
    // Create OSMD instance
    const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
        backend: "svg",
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawCredits: false,
        drawPartNames: false,
        drawPartAbbreviations: false,
        drawMeasureNumbers: false,
        autoResize: false
    });
    
    // Load and render
    osmd.load(fragmentXML).then(() => {
        osmd.render();
        
        // Post-process: apply orange theme and extract note positions
        setTimeout(() => {
            applyOrangeTheme();
            colorNotesBasedOnGameState();
            extractNotePositions();
            updateIntervalDisplay();
        }, 50);
    }).catch(err => {
        console.error('OSMD rendering error:', err);
    });
    
    function applyOrangeTheme() {
        const svg = container.querySelector('svg');
        if (!svg) return;
        
        // Set all strokes and fills to orange
        svg.querySelectorAll('path, line, rect, text, ellipse, circle').forEach(el => {
            const fill = el.getAttribute('fill');
            const stroke = el.getAttribute('stroke');
            
            if (fill && fill !== 'none' && fill !== 'transparent') {
                el.style.fill = '#FF8C00';
            }
            if (stroke && stroke !== 'none' && stroke !== 'transparent') {
                el.style.stroke = '#FF8C00';
            }
        });
    }
    
    function colorNotesBasedOnGameState() {
        const svg = container.querySelector('svg');
        if (!svg) return;
        
        // Find all note heads (OSMD/VexFlow uses vf-notehead class)
        const noteheads = svg.querySelectorAll('.vf-notehead');
        
        noteheads.forEach((notehead, i) => {
            if (i >= fragment.length) return;
            
            const isSelected = i === state.selectedNoteIndex;
            const isCorrect = state.userPitches[i] === fragment[i].midi;
            
            let color = '#FF8C00'; // default orange
            if (state.submitted) {
                color = isCorrect ? '#00FF00' : '#FF4444';
            } else if (isSelected) {
                color = '#FFFFFF';
            }
            
            // Color the notehead and its parent group (stem, beams, flags, etc.)
            const noteGroup = notehead.closest('.vf-stavenote');
            if (noteGroup) {
                noteGroup.querySelectorAll('path, line, rect, ellipse, circle').forEach(el => {
                    el.style.fill = color;
                    el.style.stroke = color;
                });
            } else {
                notehead.style.fill = color;
                notehead.style.stroke = color;
            }
        });
    }
    
    function extractNotePositions() {
        const svg = container.querySelector('svg');
        if (!svg) return;
        
        state.notePositions = [];
        const noteheads = svg.querySelectorAll('.vf-notehead');
        
        noteheads.forEach((notehead, i) => {
            if (i < fragment.length) {
                const bbox = notehead.getBBox();
                const ctm = notehead.getCTM();
                // Get absolute x position
                state.notePositions[i] = ctm ? ctm.e + bbox.x : bbox.x;
            }
        });
    }
    
    function updateIntervalDisplay() {
        if (!state.submitted && state.selectedNoteIndex >= 0 && state.selectedNoteIndex < state.userPitches.length) {
            const userMidi = state.userPitches[state.selectedNoteIndex];
            const noteName = midiToNoteName(userMidi, true);
            const display = document.getElementById('interval-display');
            if (display) {
                display.textContent = '▲ ' + noteName;
                display.style.color = '#FFFFFF';
            }
        }
    }
}

function createSVGElement(type, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', type);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}

function drawLedgerLines(svg, x, staffPos, lineSpacing, topLine) {
    const hs = lineSpacing / 2;
    const hw = 12; // half-width of ledger line
    
    // Above staff: ledger lines at staff positions 6, 8, 10... (C6=line above, etc.)
    if (staffPos >= 6) {
        for (let p = 6; p <= staffPos; p += 2) {
            const y = topLine - (p - 4) * hs;
            svg.appendChild(createSVGElement('line', {
                x1: x - hw, y1: y, x2: x + hw, y2: y,
                class: 'staff-ledger'
            }));
        }
    }
    
    // Middle C ledger line (staffPos = -6)
    if (staffPos <= -6) {
        for (let p = -6; p >= staffPos; p -= 2) {
            const y = topLine + 4 * lineSpacing - (p + 4) * hs;
            svg.appendChild(createSVGElement('line', {
                x1: x - hw, y1: y, x2: x + hw, y2: y,
                class: 'staff-ledger'
            }));
        }
    }
}

function drawNotehead(svg, x, y, type, className) {
    // Select SMuFL glyph based on note type
    let glyph;
    if (type === 'whole') glyph = SMUFL.noteheadWhole;
    else if (type === 'half') glyph = SMUFL.noteheadHalf;
    else glyph = SMUFL.noteheadBlack; // quarter, eighth, 16th
    
    // Determine fill color from className
    const fill = className.includes('correct') ? 'var(--correct)' :
                 className.includes('incorrect') ? 'var(--incorrect)' :
                 className.includes('selected') ? 'var(--selected)' : 'var(--fg)';
    
    // Font size tuned for lineSpacing = 16
    const fontSize = 36;
    const text = createSVGElement('text', {
        x: x,
        y: y + fontSize * 0.12, // baseline adjustment for SMuFL noteheads
        'font-size': fontSize,
        'font-family': 'Bravura',
        fill: fill,
        'text-anchor': 'middle',
        class: className
    });
    text.textContent = glyph;
    svg.appendChild(text);
}

function drawStem(svg, x, y, stemUp) {
    const stemH = 38;
    const stemX = x + (stemUp ? 6 : -6);
    svg.appendChild(createSVGElement('line', {
        x1: stemX, y1: y,
        x2: stemX, y2: y + (stemUp ? -stemH : stemH),
        stroke: 'var(--fg)',
        'stroke-width': 1.8
    }));
}

function drawFlag(svg, x, y, stemUp, count) {
    const stemH = 38;
    const stemX = x + (stemUp ? 6 : -6);
    const tipY = y + (stemUp ? -stemH : stemH);
    
    // Select SMuFL glyph based on flag count and direction
    let glyph;
    if (count === 1) glyph = stemUp ? SMUFL.flag8thUp : SMUFL.flag8thDown;
    else if (count === 2) glyph = stemUp ? SMUFL.flag16thUp : SMUFL.flag16thDown;
    
    if (glyph) {
        const fontSize = 36;
        const text = createSVGElement('text', {
            x: stemX,
            y: tipY + (stemUp ? fontSize * 0.1 : fontSize * 0.05),
            'font-size': fontSize,
            'font-family': 'Bravura',
            fill: 'var(--fg)',
            'text-anchor': stemUp ? 'start' : 'end'
        });
        text.textContent = glyph;
        svg.appendChild(text);
    }
}

function drawBeamGroup(svg, indices, noteData, fragment) {
    if (indices.length < 2) return;
    
    // Use first note's stem direction for the whole group
    const stemUp = noteData[indices[0]].stemUp;
    const stemH = 38;
    const beamThick = 5;
    const beamGap = 7;
    
    // Compute stem endpoints using proportional positions
    const points = indices.map(i => {
        const nd = noteData[i];
        const stemX = nd.x + (stemUp ? 6 : -6);
        const stemY = nd.y + (stemUp ? -stemH : stemH);
        return { x: stemX, y: stemY, noteY: nd.y };
    });
    
    // PRIORITY 2.7: Clamp beam angle to prevent extreme slopes
    // Calculate desired beam angle
    const first = points[0], last = points[points.length - 1];
    const deltaX = last.x - first.x;
    const deltaY = last.y - first.y;
    const maxSlope = 0.27; // ~15 degrees max
    const clampedDeltaY = Math.max(-deltaX * maxSlope, Math.min(deltaX * maxSlope, deltaY));
    
    // Adjust all beam points to follow clamped angle
    const clampedPoints = points.map((p, i) => {
        const t = deltaX !== 0 ? (p.x - first.x) / deltaX : 0;
        const clampedY = first.y + clampedDeltaY * t;
        return { ...p, y: clampedY };
    });
    
    // Draw stems to clamped beam positions
    indices.forEach((idx, gi) => {
        const nd = noteData[idx];
        const stemX = nd.x + (stemUp ? 6 : -6);
        svg.appendChild(createSVGElement('line', {
            x1: stemX, y1: nd.y,
            x2: stemX, y2: clampedPoints[gi].y,
            stroke: 'var(--fg)',
            'stroke-width': 1.8
        }));
    });
    
    // Primary beam (eighth notes) with clamped angle
    const firstClamped = clampedPoints[0], lastClamped = clampedPoints[clampedPoints.length - 1];
    svg.appendChild(createSVGElement('polygon', {
        points: `${firstClamped.x},${firstClamped.y} ${lastClamped.x},${lastClamped.y} ${lastClamped.x},${lastClamped.y + (stemUp ? beamThick : -beamThick)} ${firstClamped.x},${firstClamped.y + (stemUp ? beamThick : -beamThick)}`,
        fill: 'var(--fg)'
    }));
    
    // Secondary beam for 16th notes (use clamped points)
    indices.forEach((idx, gi) => {
        if (fragment[idx].type === '16th') {
            const p = clampedPoints[gi];
            const beamY = p.y + (stemUp ? beamGap : -beamGap);
            // Extend to next or previous point
            let p2;
            if (gi < clampedPoints.length - 1 && fragment[indices[gi + 1]].type === '16th') {
                p2 = clampedPoints[gi + 1];
            } else if (gi > 0) {
                p2 = clampedPoints[gi - 1];
            } else {
                // Stub beam
                p2 = { x: p.x + (stemUp ? 12 : -12), y: beamY };
            }
            const beamY2 = p2.y + (stemUp ? beamGap : -beamGap);
            svg.appendChild(createSVGElement('polygon', {
                points: `${p.x},${beamY} ${p2.x},${beamY2} ${p2.x},${beamY2 + (stemUp ? beamThick : -beamThick)} ${p.x},${beamY + (stemUp ? beamThick : -beamThick)}`,
                fill: 'var(--fg)'
            }));
        }
    });
}

// ============================================================================
// GAME LOGIC
// ============================================================================

async function startGame(song) {
    showLoading('Loading song...');
    
    const songData = await loadSongXML(song);
    if (!songData) return;
    
    // Reset scoring state
    state.totalScore = 0;
    state.streak = 0;
    state.maxStreak = 0;
    state.fragmentScores = [];
    
    // NEW: Start session timer
    state.stats.sessionStart = Date.now();
    state.stats.sessionFragments = 0;
    state.stats.sessionAccuracy = 0;
    
    // PRIORITY 5.22: Load audio with error recovery
    const audio = document.getElementById('reference-audio');
    audio.src = song.audioPath;
    audio.playbackRate = state.settings.defaultSpeed;
    audio.volume = state.settings.defaultVolume;
    
    // Update UI sliders to match settings
    document.getElementById('speed-slider').value = state.settings.defaultSpeed;
    document.getElementById('speed-value').textContent = `${(state.settings.defaultSpeed * 100).toFixed(0)}%`;
    document.getElementById('volume-slider').value = state.settings.defaultVolume;
    document.getElementById('volume-value').textContent = `${(state.settings.defaultVolume * 100).toFixed(0)}%`;
    
    // Decode audio for DTW alignment
    showLoading('Syncing audio...');
    try {
        if (!state.audioCtx) {
            state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const audioResponse = await fetch(song.audioPath);
        if (!audioResponse.ok) {
            throw new Error(`Failed to load audio: ${audioResponse.status}`);
        }
        const arrayBuf = await audioResponse.arrayBuffer();
        state.audioBuf = await state.audioCtx.decodeAudioData(arrayBuf);
        
        // Perform DTW alignment
        state.timeMap = await performAlignment(songData, state.audioBuf);
        console.log(`Alignment complete: ${state.timeMap.length} mapping points`);
    } catch (e) {
        console.error('Alignment failed, falling back to tempo-based sync:', e);
        state.timeMap = null;
        // Continue anyway - tempo-based sync is acceptable fallback
    }
    
    // Request wake lock (keep screen on)
    requestWakeLock();
    
    // Start first fragment
    loadFragment(0);
    
    // PRIORITY 4.15: Smooth screen transitions
    const songSelect = document.getElementById('song-select-screen');
    const gameScreen = document.getElementById('game-screen');
    songSelect.classList.add('fade-out');
    setTimeout(() => {
        showScreen('game-screen');
        gameScreen.classList.add('fade-in');
        setTimeout(() => {
            songSelect.classList.remove('fade-out');
            gameScreen.classList.remove('fade-in');
        }, 300);
    }, 300);
    
    document.getElementById('song-title').textContent = song.name;
    
    hideLoading();
    
    // PRIORITY 3.11: Show how-to-play on first game
    showHowToPlay();
    
    // If tutorial not shown, auto-play first fragment
    const hasSeenTutorial = localStorage.getItem('cpm_seen_tutorial');
    if (hasSeenTutorial) {
        setTimeout(() => playFragmentAudio(), 500);
    }
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            state.wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake lock activated');
        } catch (e) {
            console.log('Wake lock failed:', e);
        }
    }
}

function loadFragment(index) {
    if (index >= state.fragments.length) {
        showScoreSummary();
        return;
    }
    
    state.currentFragmentIndex = index;
    state.currentFragment = state.fragments[index];
    state.selectedNoteIndex = 0;
    state.submitted = false;
    state.undoStack = [];
    
    // Initialize user pitches (all start at B4 = MIDI 71)
    state.userPitches = state.currentFragment.map(() => 71);
    
    // Update UI
    updateGameHeader();
    document.getElementById('submit-btn').style.display = 'flex';
    document.getElementById('next-btn').style.display = 'none';
    const playAnswerBtn = document.getElementById('play-answer-btn');
    if (playAnswerBtn) playAnswerBtn.style.display = 'none';
    const intervalDisplay = document.getElementById('interval-display');
    if (intervalDisplay) intervalDisplay.classList.remove('show');
    document.getElementById('skip-btn').style.display = 'flex';
    document.getElementById('show-answer-btn').style.display = 'flex';
    document.getElementById('undo-btn').style.display = 'flex';
    
    // Render staff
    renderStaff();
    
    // Scroll staff to beginning so clef/time sig are visible
    requestAnimationFrame(() => {
        const staffContainer = document.querySelector('.staff-container');
        if (staffContainer) staffContainer.scrollLeft = 0;
    });
}

function updateGameHeader() {
    const fragNum = state.currentFragmentIndex + 1;
    const total = state.fragments.length;
    const progress = (fragNum / total) * 100;
    
    // PRIORITY 1.5: Compact mobile header
    // Format: "Frag 1/55 · Lv1 · 🔥3" (if streak >= 5)
    let streakText = '';
    if (state.streak >= 5) {
        streakText = ` · <span class="streak-fire">🔥</span>${state.streak}`;
    }
    
    document.getElementById('fragment-info').innerHTML = 
        `Frag ${fragNum}/${total} · Lv${state.stats.level}${streakText}`;
    document.getElementById('score-display').textContent = state.totalScore;
    document.getElementById('progress-bar').style.width = `${progress}%`;
}

function moveNote(direction) {
    if (state.submitted) return;
    
    const fragment = state.currentFragment;
    if (!fragment) return;
    
    if (direction === 'left') {
        state.selectedNoteIndex = Math.max(0, state.selectedNoteIndex - 1);
    } else if (direction === 'right') {
        state.selectedNoteIndex = Math.min(fragment.length - 1, state.selectedNoteIndex + 1);
    }
    
    renderStaff();
    scrollToSelectedNote();
}

function scrollToSelectedNote() {
    if (!state.notePositions) return;
    const container = document.querySelector('.staff-container');
    if (!container) return;
    const x = state.notePositions[state.selectedNoteIndex];
    if (x == null) return;
    // Scroll so the selected note is roughly centered
    const targetScroll = x - container.clientWidth / 2;
    container.scrollTo({ left: Math.max(0, targetScroll), behavior: 'smooth' });
}

function adjustPitch(semitones) {
    if (state.submitted) return;
    
    const index = state.selectedNoteIndex;
    const currentPitch = state.userPitches[index];
    const newPitch = Math.max(MIDI_RANGE.min, Math.min(MIDI_RANGE.max, currentPitch + semitones));
    
    if (newPitch !== currentPitch) {
        // Save to undo stack
        state.undoStack.push([...state.userPitches]);
        if (state.undoStack.length > 20) state.undoStack.shift();
        
        state.userPitches[index] = newPitch;
        
        // Haptic feedback
        haptic(10);
        
        // Play preview
        playPreviewNote(newPitch);
        
        renderStaff();
        updateIntervalDisplay();
        
        // NEW: Trigger note animation
        const svg = document.getElementById('staff-svg');
        const noteheads = svg.querySelectorAll('.notehead');
        if (noteheads[index]) {
            noteheads[index].classList.add('animating');
            setTimeout(() => noteheads[index].classList.remove('animating'), 200);
        }
    }
}

// NEW: Update interval display
function updateIntervalDisplay() {
    if (!state.settings.showIntervals) return;
    
    const display = document.getElementById('interval-display');
    const index = state.selectedNoteIndex;
    
    if (index > 0 && !state.submitted) {
        const prevPitch = state.userPitches[index - 1];
        const currPitch = state.userPitches[index];
        const interval = calculateInterval(prevPitch, currPitch);
        const intervalName = getIntervalName(interval, interval >= 0 ? 1 : -1);
        
        display.textContent = `Interval: ${intervalName}`;
        display.classList.add('show');
    } else {
        display.classList.remove('show');
    }
}

// NEW: Update bird mascot reaction
function updateBirdMascot(emotion = 'neutral') {
    const bird = document.getElementById('bird-mascot');
    bird.className = 'bird-mascot';
    
    if (emotion === 'happy') {
        bird.classList.add('happy');
        setTimeout(() => bird.classList.remove('happy'), 500);
    } else if (emotion === 'sad') {
        bird.classList.add('sad');
        setTimeout(() => bird.classList.remove('sad'), 500);
    } else if (emotion === 'dance') {
        bird.classList.add('dance');
    }
}

function submitAnswer() {
    if (state.submitted) return;
    
    state.submitted = true;
    
    // Calculate score
    let correct = 0;
    let incorrect = 0;
    state.currentFragment.forEach((note, i) => {
        if (state.userPitches[i] === note.midi) {
            correct++;
        } else {
            incorrect++;
        }
    });
    
    const total = state.currentFragment.length;
    const accuracy = (correct / total) * 100;
    
    // Calculate stars (0-3)
    let stars = 0;
    if (accuracy >= 100) stars = 3;
    else if (accuracy >= 80) stars = 2;
    else if (accuracy >= 60) stars = 1;
    
    // Update streak
    if (correct === total) {
        state.streak += correct;
        state.maxStreak = Math.max(state.maxStreak, state.streak);
    } else {
        state.streak = 0;
    }
    
    // Calculate fragment score with combo multiplier
    const basePoints = 10;
    const comboMultiplier = Math.min(5, 1 + Math.floor(state.streak / 10));
    const fragmentScore = (correct * basePoints + (stars * 50)) * comboMultiplier;
    state.totalScore += fragmentScore;
    
    // Save fragment result
    state.fragmentScores.push({ accuracy, stars, score: fragmentScore });
    
    // NEW: Update stats
    state.stats.totalNotes += total;
    state.stats.correctNotes += correct;
    state.stats.sessionFragments++;
    state.stats.sessionAccuracy = (state.stats.correctNotes / state.stats.totalNotes) * 100;
    
    // NEW: Add XP
    const xpGain = correct * 10 + stars * 25;
    addXP(xpGain);
    
    // NEW: Check achievements
    checkAchievements(correct, total, accuracy);
    
    // Show combo multiplier if active
    if (comboMultiplier > 1 && correct === total) {
        showComboMultiplier(comboMultiplier);
    }
    
    // Animate results (cascade effect)
    animateResults(correct === total);
    
    // Sound & haptic feedback
    if (correct === total) {
        playSFX('perfect');
        haptic(50);
        showPerfectFlash();
        updateBirdMascot('dance');
    } else {
        if (stars > 0) {
            playSFX('correct');
            updateBirdMascot('happy');
        } else {
            playSFX('incorrect');
            updateBirdMascot('sad');
        }
        haptic(20);
    }
    
    // Update UI
    updateGameHeader();
    renderStaff();
    
    // Show result overlay
    showFragmentResult(accuracy, stars, fragmentScore, comboMultiplier);
    
    // Hide submit, show next
    document.getElementById('submit-btn').style.display = 'none';
    document.getElementById('next-btn').style.display = 'flex';
    document.getElementById('skip-btn').style.display = 'none';
    document.getElementById('show-answer-btn').style.display = 'none';
    document.getElementById('undo-btn').style.display = 'none';
    document.getElementById('play-answer-btn').style.display = 'flex';
}

// NEW: Check and unlock achievements
function checkAchievements(correct, total, accuracy) {
    // First perfect
    if (correct === total && state.stats.totalNotes === total) {
        unlockAchievement('first_perfect', 'First Perfect', 'Ace your first fragment');
    }
    
    // 10 streak
    if (state.streak >= 10 && !state.stats.achievements.includes('streak_10')) {
        unlockAchievement('streak_10', '10 Streak', 'Get 10 notes in a row');
    }
    
    // 50 streak
    if (state.streak >= 50 && !state.stats.achievements.includes('streak_50')) {
        unlockAchievement('streak_50', 'Hot Streak', 'Get 50 notes in a row');
    }
    
    // 100 total notes
    if (state.stats.totalNotes >= 100 && !state.stats.achievements.includes('notes_100')) {
        unlockAchievement('notes_100', 'Century', 'Play 100 notes');
    }
}

// NEW: Show combo multiplier
function showComboMultiplier(multiplier) {
    const combo = document.createElement('div');
    combo.className = 'combo-display';
    combo.textContent = `×${multiplier}`;
    document.body.appendChild(combo);
    setTimeout(() => combo.remove(), 800);
}

function animateResults(perfect) {
    // Add cascade class to trigger CSS animation
    const svg = document.getElementById('staff-svg');
    svg.classList.add('result-cascade');
    setTimeout(() => svg.classList.remove('result-cascade'), 1000);
}

function showPerfectFlash() {
    const flash = document.createElement('div');
    flash.className = 'perfect-flash';
    flash.textContent = 'PERFECT!';
    document.getElementById('game-screen').appendChild(flash);
    setTimeout(() => flash.remove(), 1500);
}

// PRIORITY 4.12: Show score popup near notes
function showScorePopup(x, y, points) {
    const svg = document.getElementById('staff-svg');
    const rect = svg.getBoundingClientRect();
    
    const popup = document.createElement('div');
    popup.className = 'score-popup';
    popup.textContent = `+${points}`;
    popup.style.left = `${rect.left + x}px`;
    popup.style.top = `${rect.top + y}px`;
    popup.style.position = 'fixed';
    
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 1000);
}

// PRIORITY 4.16: Improved result overlay
function showFragmentResult(accuracy, stars, score, multiplier = 1) {
    const container = document.getElementById('result-overlay');
    const xpGain = state.currentFragment.reduce((sum, note, i) => 
        sum + (state.userPitches[i] === note.midi ? 10 : 0), 0) + stars * 25;
    
    container.innerHTML = `
        <div class="result-content">
            <div class="result-stars" style="font-size: 2rem; margin-bottom: 0.5rem;">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</div>
            <div class="result-accuracy" style="font-size: 1.5rem; margin-bottom: 0.5rem;">${accuracy.toFixed(0)}%</div>
            <div class="result-score" style="font-size: 0.85rem; color: var(--fg);">+${score} pts ${multiplier > 1 ? `<span style="color: var(--fg);">(×${multiplier})</span>` : ''}</div>
            <div class="result-xp" style="font-size: 0.5rem; color: var(--fg-dim); margin-top: 0.5rem;">+${xpGain} XP</div>
        </div>
    `;
    container.classList.add('active');
    setTimeout(() => container.classList.remove('active'), 1500);
}

// NEW: Add touch gesture support for swipe navigation
function setupTouchGestures() {
    const staffContainer = document.querySelector('.staff-container');
    const svg = document.getElementById('staff-svg');
    
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    
    staffContainer.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
    });
    
    staffContainer.addEventListener('touchend', (e) => {
        if (state.submitted) return;
        
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const touchEndTime = Date.now();
        
        const deltaX = touchEndX - touchStartX;
        const deltaY = touchEndY - touchStartY;
        const deltaTime = touchEndTime - touchStartTime;
        
        // Swipe detection: minimum 30px, maximum 300ms
        if (Math.abs(deltaX) > 30 && Math.abs(deltaX) > Math.abs(deltaY) * 2 && deltaTime < 300) {
            if (deltaX > 0) {
                // Swipe right - previous note
                moveNote('left');
                haptic(8);
            } else {
                // Swipe left - next note
                moveNote('right');
                haptic(8);
            }
        }
    });
    
    // NEW: Tap on notehead to select (updated for proportional spacing)
    svg.addEventListener('click', (e) => {
        if (state.submitted) return;
        if (!state.currentFragment || state.currentFragment.length === 0) return;
        
        const rect = svg.getBoundingClientRect();
        const viewBox = svg.viewBox.baseVal;
        const svgX = (e.clientX - rect.left) / rect.width * viewBox.width;
        
        // Find nearest note by X position
        // We need to reconstruct positions (same logic as in renderStaff)
        const fragment = state.currentFragment;
        const divisions = state.currentSongData?.divisions || 120;
        const screenWidth = window.innerWidth;
        const config = getStaffConfig();
        const leftMargin = config.leftMargin;
        const availableWidth = (screenWidth < 768 ? screenWidth - 120 : screenWidth - 160);
        
        const layoutItems = [];
        for (let i = 0; i < fragment.length; i++) {
            if (i > 0) {
                const prevEnd = fragment[i-1].startDiv + fragment[i-1].duration;
                const gap = fragment[i].startDiv - prevEnd;
                if (gap > 0) {
                    layoutItems.push({ type: 'rest', duration: gap, index: -1 });
                }
            }
            layoutItems.push({ type: 'note', duration: fragment[i].duration, index: i, note: fragment[i] });
        }
        
        const totalWeight = layoutItems.reduce((sum, item) => sum + Math.sqrt(item.duration), 0);
        let currentX = leftMargin;
        const positions = [];
        
        layoutItems.forEach(item => {
            const weight = Math.sqrt(item.duration);
            const width = Math.max(25, (weight / totalWeight) * availableWidth);
            if (item.type === 'note') {
                positions[item.index] = currentX + width / 2;
            }
            currentX += width;
        });
        
        // Find closest note
        let closestIndex = 0;
        let closestDist = Math.abs(svgX - positions[0]);
        for (let i = 1; i < positions.length; i++) {
            const dist = Math.abs(svgX - positions[i]);
            if (dist < closestDist) {
                closestDist = dist;
                closestIndex = i;
            }
        }
        
        if (closestDist < 30) { // Within 30px
            state.selectedNoteIndex = closestIndex;
            renderStaff();
            updateIntervalDisplay();
            haptic(8);
        }
    });
}

function nextFragment() {
    loadFragment(state.currentFragmentIndex + 1);
    
    // Auto-play next fragment
    setTimeout(() => playFragmentAudio(), 300);
}

function skipFragment() {
    if (state.submitted) return;
    
    // Mark as skipped with 0 score
    state.fragmentScores.push({ accuracy: 0, stars: 0, score: 0 });
    state.streak = 0;
    
    nextFragment();
}

function showAnswer() {
    if (state.submitted) return;
    
    // Copy correct answers, apply score penalty
    state.userPitches = state.currentFragment.map(note => note.midi);
    state.fragmentScores.push({ accuracy: 100, stars: 0, score: 0 }); // No points
    state.streak = 0;
    
    renderStaff();
    
    // Show next button
    state.submitted = true;
    document.getElementById('submit-btn').style.display = 'none';
    document.getElementById('next-btn').style.display = 'flex';
    document.getElementById('skip-btn').style.display = 'none';
    document.getElementById('show-answer-btn').style.display = 'none';
    document.getElementById('undo-btn').style.display = 'none';
}

function undoLastChange() {
    if (state.submitted || state.undoStack.length === 0) return;
    
    state.userPitches = state.undoStack.pop();
    renderStaff();
    haptic(8);
}

function playUserAnswer() {
    if (!state.pianoSampler || !state.audioInitialized) return;
    
    const now = Tone.now();
    state.userPitches.forEach((midi, i) => {
        const noteName = midiToNoteName(midi, true);
        state.pianoSampler.triggerAttackRelease(noteName, "8n", now + i * 0.3);
    });
}

// PRIORITY 4.17: Improved song completion screen
function showScoreSummary() {
    // Calculate final stats
    const totalFragments = state.fragmentScores.length;
    const totalAccuracy = state.fragmentScores.reduce((sum, f) => sum + f.accuracy, 0) / totalFragments;
    const totalStars = state.fragmentScores.reduce((sum, f) => sum + f.stars, 0);
    
    // Check if new best
    const prevBest = loadSongStats(state.currentSong.name).bestScore;
    const isNewBest = state.totalScore > prevBest;
    
    // Save to localStorage
    saveSongStats(state.currentSong.name, {
        score: state.totalScore,
        stars: totalStars,
        accuracy: totalAccuracy
    });
    
    // NEW: Update global stats
    state.stats.songsCompleted++;
    saveStats();
    
    // PRIORITY 4.14: Bird celebration dance
    updateBirdMascot('dance');
    
    // Show summary overlay
    const overlay = document.getElementById('summary-overlay');
    overlay.innerHTML = `
        <div class="summary-content">
            <h2>SONG COMPLETE!</h2>
            ${isNewBest ? '<div style="font-size: 0.7rem; color: var(--correct); margin-bottom: 0.5rem;">🎉 NEW BEST! 🎉</div>' : ''}
            <div class="summary-song">${state.currentSong.name}</div>
            <div class="summary-stat">
                <div class="stat-label">Total Score</div>
                <div class="stat-value">${state.totalScore}</div>
            </div>
            <div class="summary-stat">
                <div class="stat-label">Accuracy</div>
                <div class="stat-value">${totalAccuracy.toFixed(1)}%</div>
            </div>
            <div class="summary-stat">
                <div class="stat-label">Stars Earned</div>
                <div class="stat-value">${'★'.repeat(Math.min(3, Math.floor(totalStars / totalFragments)))} ${totalStars}/${totalFragments * 3}</div>
            </div>
            <div class="summary-stat">
                <div class="stat-label">Max Streak</div>
                <div class="stat-value">${state.maxStreak}</div>
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 1.5rem; justify-content: center;">
                <button id="summary-replay-btn" class="action-btn" style="flex: 1;">PLAY AGAIN</button>
                <button id="summary-list-btn" class="action-btn" style="flex: 1;">SONG LIST</button>
            </div>
        </div>
    `;
    overlay.classList.add('active');
    
    document.getElementById('summary-replay-btn').addEventListener('click', () => {
        overlay.classList.remove('active');
        startGame(state.currentSong);
    });
    
    document.getElementById('summary-list-btn').addEventListener('click', () => {
        overlay.classList.remove('active');
        showScreen('song-select-screen');
        renderSongList(); // Refresh with updated stats
        updateBirdMascot('neutral'); // Stop celebration
    });
}

// NEW: Share result (Wordle-style)
function shareResult(songName, accuracy, stars, maxStars, score) {
    const starBar = '★'.repeat(Math.floor(stars / 3)) + '☆'.repeat(Math.floor((maxStars - stars) / 3));
    const text = `🎵 Charlie Parker's Mind 🎵\n\n${songName}\n${starBar}\n${accuracy.toFixed(0)}% accuracy\n${score} points\n\nPlay at: [Your URL]`;
    
    if (navigator.share) {
        navigator.share({
            title: 'Charlie Parker\'s Mind',
            text: text
        }).catch(() => {
            // Fallback to clipboard
            copyToClipboard(text);
        });
    } else {
        copyToClipboard(text);
    }
}

function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            alert('Result copied to clipboard!');
        }).catch(() => {
            fallbackCopyToClipboard(text);
        });
    } else {
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        alert('Result copied to clipboard!');
    } catch (e) {
        alert('Failed to copy. Please copy manually:\n\n' + text);
    }
    document.body.removeChild(textarea);
}

// ============================================================================
// UI EVENT HANDLERS
// ============================================================================

function setupEventListeners() {
    // D-pad controls with repeat
    let repeatInterval = null;
    let repeatTimeout = null;
    
    const startRepeat = (fn) => {
        fn();
        repeatTimeout = setTimeout(() => {
            repeatInterval = setInterval(fn, 150);
        }, 500);
    };
    
    const stopRepeat = () => {
        if (repeatTimeout) clearTimeout(repeatTimeout);
        if (repeatInterval) clearInterval(repeatInterval);
        repeatTimeout = null;
        repeatInterval = null;
    };
    
    ['mousedown', 'touchstart'].forEach(evt => {
        document.getElementById('up-btn').addEventListener(evt, (e) => {
            e.preventDefault();
            startRepeat(() => adjustPitch(1));
        });
        document.getElementById('down-btn').addEventListener(evt, (e) => {
            e.preventDefault();
            startRepeat(() => adjustPitch(-1));
        });
    });
    
    ['mouseup', 'touchend', 'touchcancel'].forEach(evt => {
        document.getElementById('up-btn').addEventListener(evt, stopRepeat);
        document.getElementById('down-btn').addEventListener(evt, stopRepeat);
    });
    
    document.getElementById('left-btn').addEventListener('click', () => { moveNote('left'); haptic(8); });
    document.getElementById('right-btn').addEventListener('click', () => { moveNote('right'); haptic(8); });
    
    // Action buttons
    document.getElementById('replay-btn').addEventListener('click', () => {
        haptic(10);
        // Loop playback: restart if already playing
        const audio = document.getElementById('reference-audio');
        if (state.playbackActive) {
            stopPlaybackCursor();
            audio.pause();
        }
        playFragmentAudio();
    });
    
    document.getElementById('submit-btn').addEventListener('click', () => {
        haptic(15);
        submitAnswer();
    });
    
    document.getElementById('next-btn').addEventListener('click', () => {
        haptic(10);
        nextFragment();
    });
    
    document.getElementById('skip-btn').addEventListener('click', () => {
        if (confirm('Skip this fragment?')) {
            haptic(10);
            skipFragment();
        }
    });
    
    document.getElementById('show-answer-btn').addEventListener('click', () => {
        if (confirm('Reveal answer? (No points awarded)')) {
            haptic(10);
            showAnswer();
        }
    });
    
    document.getElementById('undo-btn').addEventListener('click', () => {
        undoLastChange();
    });
    
    document.getElementById('play-answer-btn').addEventListener('click', () => {
        haptic(10);
        playUserAnswer();
    });
    
    // PRIORITY 1.2: Settings gear toggle
    const settingsGear = document.getElementById('settings-gear');
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsGear && settingsPanel) {
        settingsGear.addEventListener('click', () => {
            settingsPanel.classList.toggle('active');
            settingsGear.classList.toggle('active');
            haptic(10);
        });
    }
    
    // Speed and volume controls
    document.getElementById('speed-slider').addEventListener('input', (e) => {
        const speed = parseFloat(e.target.value);
        document.getElementById('reference-audio').playbackRate = speed;
        document.getElementById('speed-value').textContent = `${(speed * 100).toFixed(0)}%`;
    });
    
    document.getElementById('volume-slider').addEventListener('input', (e) => {
        const volume = parseFloat(e.target.value);
        document.getElementById('reference-audio').volume = volume;
        document.getElementById('volume-value').textContent = `${(volume * 100).toFixed(0)}%`;
    });
    
    // Back button
    document.getElementById('back-btn').addEventListener('click', () => {
        if (confirm('Exit song?')) {
            showScreen('song-select-screen');
            const audio = document.getElementById('reference-audio');
            audio.pause();
            audio.src = '';
            if (state.wakeLock) {
                state.wakeLock.release();
                state.wakeLock = null;
            }
        }
    });
    
    // Keyboard support
    document.addEventListener('keydown', (e) => {
        if (document.getElementById('game-screen').classList.contains('active')) {
            switch(e.key) {
                case 'ArrowUp': adjustPitch(1); break;
                case 'ArrowDown': adjustPitch(-1); break;
                case 'ArrowLeft': moveNote('left'); break;
                case 'ArrowRight': moveNote('right'); break;
                case 'Enter': 
                    if (state.submitted) {
                        nextFragment();
                    } else {
                        submitAnswer();
                    }
                    break;
                case ' ':
                    e.preventDefault();
                    playFragmentAudio();
                    break;
                case 'u':
                    undoLastChange();
                    break;
            }
        }
    });
    
    // Touch gesture to initialize audio on iOS
    document.addEventListener('touchstart', async () => {
        if (!state.audioInitialized) {
            await Tone.start();
            await initializePiano();
            state.audioInitialized = true;
            console.log('Audio initialized');
        }
    }, { once: true });
    
    // Also try to initialize on click
    document.addEventListener('click', async () => {
        if (!state.audioInitialized) {
            await Tone.start();
            await initializePiano();
            state.audioInitialized = true;
            console.log('Audio initialized');
        }
    }, { once: true });
    
    // About link
    const aboutLink = document.getElementById('about-link');
    if (aboutLink) {
        aboutLink.addEventListener('click', (e) => {
            e.preventDefault();
            alert('Charlie Parker\'s Mind v0.1\n\nA Flipper Zero-themed ear training game.\n\nLearn Charlie Parker solos by listening to fragments and matching the pitches.\n\nBuilt with Web Audio API, Tone.js, and DTW alignment.\n\n© 2024');
        });
    }
    
    // NEW: Stats link
    const statsLink = document.getElementById('stats-link');
    if (statsLink) {
        statsLink.addEventListener('click', (e) => {
            e.preventDefault();
            showStatsScreen();
        });
    }
    
    // NEW: Settings link
    const settingsLink = document.getElementById('settings-link');
    if (settingsLink) {
        settingsLink.addEventListener('click', (e) => {
            e.preventDefault();
            showSettingsScreen();
        });
    }
    
    // NEW: Stats back button
    const statsBackBtn = document.getElementById('stats-back-btn');
    if (statsBackBtn) {
        statsBackBtn.addEventListener('click', () => {
            showScreen('song-select-screen');
        });
    }
    
    // NEW: Settings back button
    const settingsBackBtn = document.getElementById('settings-back-btn');
    if (settingsBackBtn) {
        settingsBackBtn.addEventListener('click', () => {
            showScreen('song-select-screen');
        });
    }
    
    // NEW: Settings inputs
    const noteNamesCheckbox = document.getElementById('setting-note-names');
    if (noteNamesCheckbox) {
        noteNamesCheckbox.addEventListener('change', (e) => {
            state.settings.showNoteNames = e.target.checked;
            saveSettings();
        });
    }
    
    const intervalsCheckbox = document.getElementById('setting-intervals');
    if (intervalsCheckbox) {
        intervalsCheckbox.addEventListener('change', (e) => {
            state.settings.showIntervals = e.target.checked;
            saveSettings();
        });
    }
    
    const scaleDegreesCheckbox = document.getElementById('setting-scale-degrees');
    if (scaleDegreesCheckbox) {
        scaleDegreesCheckbox.addEventListener('change', (e) => {
            state.settings.showScaleDegrees = e.target.checked;
            saveSettings();
        });
    }
    
    const defaultSpeedSlider = document.getElementById('setting-default-speed');
    if (defaultSpeedSlider) {
        defaultSpeedSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            state.settings.defaultSpeed = speed;
            document.getElementById('setting-speed-value').textContent = `${(speed * 100).toFixed(0)}%`;
            saveSettings();
        });
    }
    
    const defaultVolumeSlider = document.getElementById('setting-default-volume');
    if (defaultVolumeSlider) {
        defaultVolumeSlider.addEventListener('input', (e) => {
            const volume = parseFloat(e.target.value);
            state.settings.defaultVolume = volume;
            document.getElementById('setting-volume-value').textContent = `${(volume * 100).toFixed(0)}%`;
            saveSettings();
        });
    }
}

// NEW: Show stats screen
function showStatsScreen() {
    document.getElementById('stat-level').textContent = state.stats.level;
    document.getElementById('stat-xp').textContent = state.stats.xp;
    document.getElementById('stat-songs').textContent = state.stats.songsCompleted;
    document.getElementById('stat-notes').textContent = state.stats.totalNotes;
    const accuracy = state.stats.totalNotes > 0 
        ? ((state.stats.correctNotes / state.stats.totalNotes) * 100).toFixed(1) 
        : 0;
    document.getElementById('stat-accuracy').textContent = `${accuracy}%`;
    document.getElementById('stat-achievements').textContent = state.stats.achievements.length;
    
    showScreen('stats-screen');
}

// NEW: Show settings screen
function showSettingsScreen() {
    document.getElementById('setting-note-names').checked = state.settings.showNoteNames;
    document.getElementById('setting-intervals').checked = state.settings.showIntervals;
    document.getElementById('setting-scale-degrees').checked = state.settings.showScaleDegrees;
    document.getElementById('setting-default-speed').value = state.settings.defaultSpeed;
    document.getElementById('setting-speed-value').textContent = `${(state.settings.defaultSpeed * 100).toFixed(0)}%`;
    document.getElementById('setting-default-volume').value = state.settings.defaultVolume;
    document.getElementById('setting-volume-value').textContent = `${(state.settings.defaultVolume * 100).toFixed(0)}%`;
    
    showScreen('settings-screen');
}

function renderSongList() {
    const songList = document.getElementById('song-list');
    songList.innerHTML = '';
    
    // Add search box
    const searchBox = document.createElement('input');
    searchBox.type = 'text';
    searchBox.id = 'song-search';
    searchBox.className = 'song-search';
    searchBox.placeholder = 'Search songs...';
    searchBox.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const items = songList.querySelectorAll('.song-item');
        items.forEach(item => {
            const match = item.dataset.name.toLowerCase().includes(query);
            item.style.display = match ? 'flex' : 'none';
        });
    });
    songList.appendChild(searchBox);
    
    // Group songs alphabetically
    const groups = {};
    state.songs.forEach(song => {
        const firstLetter = song.name[0].toUpperCase();
        if (!groups[firstLetter]) groups[firstLetter] = [];
        groups[firstLetter].push(song);
    });
    
    // Render groups
    Object.keys(groups).sort().forEach(letter => {
        const header = document.createElement('div');
        header.className = 'song-category';
        header.textContent = `— ${letter} —`;
        songList.appendChild(header);
        
        groups[letter].forEach(song => {
            const stats = loadSongStats(song.name);
            const difficulty = calculateDifficulty(song);
            const difficultyDots = '●'.repeat(difficulty) + '○'.repeat(3 - difficulty);
            
            const item = document.createElement('div');
            item.className = 'song-item';
            item.dataset.name = song.name;
            
            item.innerHTML = `
                <div class="song-item-main">
                    <div class="song-item-title">${song.name}</div>
                    <div class="song-item-difficulty">${difficultyDots}</div>
                </div>
                ${stats.bestScore > 0 ? `
                    <div class="song-item-stats">
                        <span class="song-stat-stars">${'★'.repeat(Math.min(3, Math.floor(stats.stars / 10)))}</span>
                        <span class="song-stat-score">${stats.bestScore}</span>
                    </div>
                ` : ''}
            `;
            
            item.addEventListener('click', () => startGame(song));
            songList.appendChild(item);
        });
    });
}

// ============================================================================
// PRIORITY 3: FIRST-TIME EXPERIENCE
// ============================================================================

function showWelcomeSplash() {
    const hasSeenSplash = localStorage.getItem('cpm_seen_splash');
    if (hasSeenSplash) return;
    
    const splash = document.getElementById('welcome-splash');
    splash.classList.add('active');
    
    // Auto-fade after 3 seconds
    setTimeout(() => {
        splash.classList.remove('active');
        localStorage.setItem('cpm_seen_splash', 'true');
    }, 3000);
}

function showHowToPlay() {
    const hasSeenTutorial = localStorage.getItem('cpm_seen_tutorial');
    if (hasSeenTutorial) return;
    
    const overlay = document.getElementById('how-to-play');
    overlay.classList.add('active');
    
    const btn = document.getElementById('how-to-play-btn');
    btn.addEventListener('click', () => {
        overlay.classList.remove('active');
        localStorage.setItem('cpm_seen_tutorial', 'true');
        // Auto-play first fragment
        setTimeout(() => playFragmentAudio(), 500);
    }, { once: true });
}

// ============================================================================
// PRIORITY 5.20: iOS AUDIO CONTEXT RESUME
// ============================================================================

function setupAudioContextResume() {
    // Resume audio context when app returns from background
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.audioCtx && state.audioCtx.state === 'suspended') {
            state.audioCtx.resume().then(() => {
                console.log('Audio context resumed');
            });
        }
    });
    
    // Also resume on any touch (iOS requirement)
    document.addEventListener('touchstart', () => {
        if (state.audioCtx && state.audioCtx.state === 'suspended') {
            state.audioCtx.resume();
        }
    }, { passive: true });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
    // NEW: Load settings and stats
    loadSettings();
    loadStats();
    
    // PRIORITY 5: iOS-specific setup
    setupAudioContextResume();
    
    setupEventListeners();
    setupTouchGestures();
    
    // PRIORITY 3.10: Show welcome splash (first visit only)
    showWelcomeSplash();
    
    await discoverSongs();
    renderSongList();
    showScreen('song-select-screen');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
