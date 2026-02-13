# Charlie Parker's Mind - Web Music Score Editor
**Documentation Date: August 18, 2025**

## Overview

Charlie Parker's Mind is a web-based music score editor that lets users view, edit, and play back musical scores. The app focuses on Charlie Parker's jazz compositions and allows users to modify note pitches while hearing the changes in real-time.

## Core Technologies

### 1. **OpenSheetMusicDisplay (OSMD)**
- **What it does**: Renders musical scores from MusicXML files into beautiful sheet music on screen
- **Version**: 1.7.6
- **Purpose**: Converts digital music notation into visual sheet music that users can see and interact with

### 2. **Tone.js Audio Engine**
- **What it does**: Handles all audio playback and synthesis
- **Purpose**: Creates piano sounds and manages timing for MIDI playback
- **Features**: 
  - High-quality Salamander piano samples
  - Precise timing control
  - Speed adjustment without quality loss

### 3. **MusicXML Processing**
- **What it does**: Reads and writes standard music notation files
- **Supported formats**: .xml, .musicxml, .mxl (compressed)
- **Purpose**: Allows importing/exporting scores that work with other music software

### 4. **JSZip Library**
- **What it does**: Handles compressed MusicXML (.mxl) files
- **Purpose**: Extracts music data from zip-compressed score files

## Main Features

### 1. **Score Display and Navigation**
- **Visual Layout**: Shows 4 measures per line for consistent reading
- **Navigation**: Use arrow keys to move between notes and rests
- **Selection**: Click on any note to select it
- **Zoom Control**: Adjust score size from 1% to 100%

### 2. **Note Editing**
- **Pitch Changes**: 
  - Up/Down arrows: Move notes by semitones (half-steps)
  - Cmd+Up/Down: Move notes by octaves (12 semitones)
  - Mouse drag: Drag notes up/down to change pitch
- **Range Limits**: Notes stay between C3 and F6 (treble clef range)
- **Smart Accidentals**: App automatically adds sharps/flats based on key signature
- **Tied Notes**: Connected notes move together as one unit

### 3. **Audio Playback System**

#### **MIDI Playback**
- **How it works**: Converts musical notes into audio using digital piano samples
- **Speed Control**: Adjust playback speed from 1% to 100% without changing pitch
- **Swing Feel**: Add jazz swing timing (50% to 75% swing ratio)
- **Volume Control**: Master volume from 0% to 100%

#### **Reference Audio Playback**
- **Purpose**: Play original recordings alongside the score
- **Speed Matching**: Reference audio speed matches the MIDI speed setting
- **Sync Feature**: Automatically aligns audio with score position

### 4. **Audio Sync Technology**

The audio sync feature is one of the most advanced parts of the app. Here's how it works:

#### **Step 1: Audio Analysis**
- **Chroma Analysis**: The app analyzes both the score and audio file to create "chroma fingerprints"
- **What is Chroma**: A 12-note pattern showing which musical notes are present at each moment
- **Process**: Breaks audio into small time windows (46ms each) and detects musical notes

#### **Step 2: Score Analysis** 
- **MIDI Conversion**: Converts the visual score into a sequence of MIDI notes with timing
- **Chroma Creation**: Creates the same 12-note pattern from the score's notes
- **Swing Application**: Adjusts timing to match jazz swing feel

#### **Step 3: Alignment Process**
- **DTW Algorithm**: Uses Dynamic Time Warping to find the best match between score and audio
- **Multiple Attempts**: Tries 12 different pitch shifts to handle transposed recordings
- **Time Mapping**: Creates a precise map linking each score position to audio time

#### **Step 4: Synchronized Playback**
- **Cursor Following**: Visual cursor moves smoothly with audio playback
- **Seeking**: When you select a note, audio jumps to the matching time
- **Real-time Updates**: Cursor position updates 60 times per second for smooth movement

### 5. **Game Mode**
- **Purpose**: Practice tool that hides original pitches
- **How it works**: Converts all notes to the same pitch (G4) so users must rely on ear training
- **Toggle**: Switch between normal score view and game mode
- **Progress Saving**: Remembers your edits in game mode

### 6. **File Management**
- **Import**: Drag and drop MusicXML files (.xml, .mxl)
- **Export**: Save edited scores in original format
- **Song Library**: Built-in collection of Charlie Parker compositions
- **Auto-save**: Remembers your last selected note for each song

## Technical Architecture

### **State Management**
The app uses a central `state` object that tracks:
- Current score data and selection
- Audio playback status
- User preferences (speed, swing, volume)
- Game mode settings
- Sync mapping data

### **Event Handling**
- **Keyboard**: Arrow keys for navigation and editing
- **Mouse**: Click to select, drag to edit pitch
- **Touch**: Mobile-friendly touch controls
- **Audio Events**: Responds to play/pause/end events

### **Performance Optimizations**
- **Selective Rendering**: Only redraws changed parts of the score
- **Scroll Locking**: Prevents unwanted scrolling during editing
- **Memory Management**: Cleans up audio resources when not needed
- **Efficient Updates**: Uses browser animation frames for smooth visuals

## User Interface Components

### **Control Panel**
- **Game Mode Toggle**: Switch between score and game modes
- **Export Button**: Save your edited score
- **Audio Controls**: Play/pause buttons for MIDI and reference audio

### **Right Panel Sliders**
- **Speed**: 1-100% playback speed
- **Volume**: 0-100% audio volume  
- **Swing**: 50-75% jazz swing feel
- **Zoom**: 1-100% score display size

### **Song Library**
- **Left Panel**: List of available Charlie Parker songs
- **Click to Load**: Select any song to load it instantly
- **Visual Feedback**: Shows which song is currently active

## Browser Compatibility

### **Required Features**
- **Web Audio API**: For audio playback and synthesis
- **SVG Support**: For rendering musical notation
- **ES6 JavaScript**: Modern JavaScript features
- **File API**: For drag-and-drop file loading

### **Supported Browsers**
- Chrome 60+
- Firefox 55+
- Safari 11+
- Edge 79+

## File Formats

### **Input Formats**
- **.xml**: Standard MusicXML files
- **.musicxml**: Alternative MusicXML extension
- **.mxl**: Compressed MusicXML (zip format)

### **Output Formats**
- Same as input format
- Preserves all original metadata
- Only modifies note pitches, keeps everything else intact

## Performance Considerations

### **Audio Loading**
- **Lazy Loading**: Piano samples load only when needed
- **Caching**: Keeps loaded samples in memory for fast playback
- **Fallback**: Uses simple synthesizer if sample loading fails

### **Score Rendering**
- **4-Measure Layout**: Enforces consistent visual layout
- **Efficient Updates**: Reuses existing visual elements when possible
- **Scroll Preservation**: Maintains scroll position during edits

### **Memory Usage**
- **Audio Buffers**: Piano samples use about 10MB of memory
- **Score Cache**: Keeps parsed score data in memory for fast access
- **Cleanup**: Automatically releases resources when switching songs

## Code Quality Analysis & Potential Issues

### **Verified Issues (Code Review Findings)**

#### **1. Confirmed Memory Leak**
- **External RAF Not Cleaned**: `state.align.rafId` from reference audio playback lacks cleanup
  - **Risk**: Animation frames accumulate on pause/resume cycles
  - **Location**: `startExternalCursorFollow()` - missing `cancelAnimationFrame(state.align.rafId)`
  - **Status**: ✅ **Confirmed** - MIDI RAF is properly cleaned, but external RAF is not

#### **2. Error Handling Gaps**
- **Sampler Error Path**: `createTonePiano()` lacks `onerror` handler for Tone.Sampler
  - **Risk**: Silent failures when audio samples fail to load
  - **Impact**: Users see spinning/hanging instead of clear error message
  - **Status**: ✅ **Confirmed** - Missing rejection path in Promise

- **Some Silent Catches**: Limited use of empty `catch(_) {}` blocks
  - **Location**: Cursor advance operations, some UI handlers
  - **Impact**: Debugging difficulty, not the widespread issue initially reported

#### **3. Performance Issues**
- **Unconditional Debug Logging**: Console output in production code paths
  - **Impact**: Performance overhead during interactions
  - **Location**: Click handlers, selection operations
  - **Status**: ✅ **Confirmed** - No debug flag gating

#### **4. Reliability Concerns**
- **CDN Dependencies**: External libraries without fallbacks
  - **Risk**: Complete app failure if CDN unavailable
  - **Libraries**: OpenSheetMusicDisplay, JSZip, FileSaver
  - **Status**: ✅ **Confirmed** - No fallback strategy

- **Hard-coded Timing**: Fixed delays throughout codebase
  - **Examples**: 50ms spin-waits, 200ms layout delays
  - **Risk**: Fragile on different devices/browsers
  - **Status**: ✅ **Confirmed** - Should use event-driven waits

#### **5. Minor Issues**
- **Global Debug Variables**: `window.__lastHover__` for debugging
  - **Impact**: Minor namespace pollution
  - **Recommendation**: Scope under single debug object

### **Corrected Analysis - Issues Initially Misidentified**

#### **❌ Event Listener Leaks** 
- **Reality**: `bindClickMapFromXmlIndex()` properly removes previous handlers via stored refs
- **Code Evidence**: `__selClickHandler` and `__selDragHandler` cleanup before re-adding

#### **❌ Audio Loading Race Conditions**
- **Reality**: `ensurePiano()` uses proper gating with `state.audio.isLoading` and wait loop
- **Code Evidence**: Prevents duplicate loading, includes fallback synth

#### **❌ Blob URL Leaks**
- **Reality**: No `URL.createObjectURL()` usage found in codebase
- **Code Evidence**: No blob URLs to clean up

#### **❌ LocalStorage Validation**
- **Reality**: Selection restore includes bounds checking and validation
- **Code Evidence**: `!Number.isNaN(idx) && idx >= 0 && idx < state.selectable.length`

#### **❌ DOM Queries in Animation Frames**
- **Reality**: Cursor sync uses OSMD APIs and binary search, not DOM queries
- **Code Evidence**: Uses precomputed `visualTimes` array, not `querySelector`

### **Potential Reliability Issues**

#### **1. Browser Compatibility**
- **Web Audio Context**: Assumes modern browser support
  - **Risk**: Fails silently on older browsers
  - **Missing**: Feature detection and graceful degradation

- **File API Dependencies**: Heavy reliance on modern File API
  - **Risk**: Breaks on browsers without full support

#### **2. Network Dependencies**
- **CDN Failures**: External libraries loaded from CDN without fallbacks
  - **Risk**: App completely breaks if CDN is down
  - **Libraries**: OpenSheetMusicDisplay, JSZip, FileSaver, Tone.js

- **Audio Sample Loading**: Piano samples loaded from local files
  - **Risk**: Silent audio failure if files missing
  - **No Fallback**: Limited error recovery

#### **3. Timing-Sensitive Code**
- **Hard-coded Delays**: Magic numbers for timing throughout code
  - **Examples**: 50ms, 200ms, 12ms delays
  - **Risk**: Breaks on slower devices or different browsers

- **Audio Sync Assumptions**: Assumes consistent audio processing timing
  - **Risk**: Cursor drift on different audio hardware

### **Security Considerations**

#### **1. File Upload Vulnerabilities**
- **No File Validation**: Accepts any file as MusicXML
  - **Risk**: Potential XSS through malicious XML
  - **Location**: `loadFile()` function

- **Blob URL Management**: Creates object URLs without cleanup
  - **Risk**: Memory leaks from unreleased blob URLs
  - **Location**: Song loading functions

#### **2. Local Storage Usage**
- **Unvalidated Data**: Reads localStorage without validation
  - **Risk**: App crashes from corrupted stored data
  - **Location**: Selection index restoration

### **Recommended Fixes (Prioritized)**

#### **High Impact - Quick Wins**
1. **Fix External RAF Cleanup**: Add `cancelAnimationFrame(state.align.rafId)` to pause/stop functions
2. **Add Sampler Error Handling**: Include `onerror` callback in `createTonePiano()` 
3. **Gate Debug Logging**: Wrap console calls with `if (state.debug)` flag
4. **Replace Fixed Delays**: Use event-driven waits instead of `setTimeout`

#### **Medium Priority**
1. **CDN Fallback Strategy**: Add local fallbacks or integrity checks
2. **File Size/Type Validation**: Enforce limits on uploaded MusicXML files
3. **Consolidate Debug Variables**: Scope under single `window.__debug` object

#### **Low Priority**
1. **Add unit tests** for critical functions
2. **Implement proper state management** (Redux/Zustand)
3. **Add performance monitoring** and metrics
4. **Create error reporting** system

### **Code Maintainability Issues**

#### **1. Large Function Sizes**
- Several functions exceed 100+ lines (e.g., `playScore()`, `init()`)
- **Impact**: Hard to debug and modify
- **Solution**: Break into smaller, focused functions

#### **2. Complex State Object**
- Single large `state` object with nested properties
- **Impact**: Difficult to track state changes
- **Solution**: Separate concerns into modules

#### **3. Mixed Responsibilities**
- Functions handling both UI and audio logic
- **Impact**: Tight coupling, hard to test
- **Solution**: Separate UI, audio, and business logic

## Future Enhancement Possibilities

### **Potential Improvements**
- **Multi-voice Editing**: Support for harmony parts and chord symbols
- **Advanced Sync**: Machine learning-based audio alignment
- **Collaboration**: Real-time collaborative editing
- **Mobile App**: Native iOS/Android versions
- **Cloud Storage**: Save and sync scores across devices

### **Technical Upgrades**
- **WebAssembly**: Faster audio processing
- **Web Workers**: Background processing for large files
- **Progressive Web App**: Offline functionality
- **Advanced Audio**: Reverb, EQ, and other effects

---

*This documentation covers the current state of Charlie Parker's Mind as of August 18, 2025. The app represents a sophisticated blend of music technology, web development, and user experience design, specifically tailored for jazz education and score editing. While functional, the codebase would benefit from addressing the identified reliability and maintainability issues for long-term stability.*
