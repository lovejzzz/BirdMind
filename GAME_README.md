# Charlie Parker's Mind - Ear Training Game

A mobile-first ear training game for learning Charlie Parker solos, styled after the classic Gameboy.

## Quick Start

1. Open `game.html` in a mobile browser (Safari on iPhone recommended)
2. Tap a song from the list
3. Listen to the fragment, then adjust the pitches using the D-pad
4. Submit your answer to see if you got it right
5. Proceed to the next fragment

## How to Play

### Song Selection
- Browse through 50 Charlie Parker tunes
- Tap any song to start

### Game Controls
- **⬆️ Up Arrow**: Raise pitch by 1 semitone (sharp preference)
- **⬇️ Down Arrow**: Lower pitch by 1 semitone (flat preference)
- **⬅️ Left Arrow**: Move to previous note
- **➡️ Right Arrow**: Move to next note
- **🔊 Replay**: Hear the fragment again
- **✓ Submit**: Check your answer
- **→ Next**: Move to next fragment (appears after submit)

### Visual Feedback
- **Blue notehead**: Currently selected note
- **Green notehead**: Correct answer
- **Red notehead**: Incorrect answer

## Features

### Fragment System
- Songs are automatically split into fragments at rests (rhythmic breaks)
- Each fragment is a short melodic phrase (2+ notes)
- Progress through fragments sequentially

### Staff Display
- Standard treble clef notation
- Note durations shown (quarter, eighth, sixteenth, etc.)
- All pitches initially set to B4 (middle line)
- Accidentals (♯/♭) displayed automatically
- Ledger lines for notes outside the staff

### Audio
- **Reference playback**: Hear the actual Charlie Parker recording (MP3)
- **Preview notes**: Tap pitch buttons to hear Salamander piano samples
- **iOS compatible**: Tap anywhere to initialize audio on first load

## Technical Details

### Architecture
- **Standalone**: No build process, no external dependencies (except Tone.js)
- **Mobile-first**: Optimized for portrait mode, one-handed play
- **Dark theme**: Gameboy-inspired green-on-black aesthetic

### Files
- `game.html` - Main HTML structure
- `game.js` - All game logic (824 lines)
- `game.css` - Mobile-first styling
- `assets/tone.min.js` - Tone.js for piano playback
- `assets/salamander/` - Piano samples (C, Ds, Fs, A per octave)
- `Songs/[SongName]/` - MusicXML and MP3 files

### Browser Support
- **Recommended**: Mobile Safari on iOS
- **Supported**: Chrome, Firefox, Safari (desktop and mobile)
- **Requirements**: 
  - JavaScript enabled
  - HTML5 Audio support
  - SVG support

### Pitch Logic
- **Range**: C3 (MIDI 48) to F6 (MIDI 89)
- **Chromatic steps**: Up/down by semitone
- **Spelling**: Sharps when going up, flats when going down
- **Staff positioning**: Standard music notation (diatonic steps)

## Development Notes

### MusicXML Parsing
- Extracts notes, rests, durations, ties from XML
- Handles tempo, divisions, time signatures
- Groups tied notes as single units

### Fragment Extraction
- Splits at rests (rhythmic boundaries)
- Filters out very short fragments (< 2 notes)
- Preserves note durations and types

### SVG Staff Rendering
- Minimal custom renderer (no OSMD dependency)
- Treble clef, 5 lines, ledger lines
- Note heads (filled/open), stems, flags
- Positioned by MIDI pitch using standard notation rules

## Testing

To test locally:
```bash
# Serve the directory
cd /Users/mengyingli/CharlieParker\'sMind
python3 -m http.server 8000

# Open in browser
# http://localhost:8000/game.html
```

For iOS testing:
1. Get your local IP: `ifconfig | grep "inet "`
2. Open `http://[YOUR_IP]:8000/game.html` on iPhone
3. Tap screen to initialize audio

## Song Library

50 Charlie Parker tunes included:
- Anthropology, Donna Lee, Ko Ko, Now's The Time
- Blues For Alice, Confirmation, Ornithology
- Scrapple From The Apple, Yardbird Suite
- And 41 more...

## License

Educational use. Charlie Parker recordings and transcriptions are used for ear training purposes.

---

**Quality Bar Checklist:**
- ✅ Works on iPhone Safari
- ✅ Touch events and gestures
- ✅ Viewport and safe area handling
- ✅ One-handed portrait mode playable
- ✅ Audio works on iOS (user gesture requirement)
- ✅ Under 1500 lines of JavaScript (824 lines)
- ✅ No external dependencies beyond Tone.js
- ✅ Standalone HTML/CSS/JS files
- ✅ Dark Gameboy theme
- ✅ Big touch targets (min 48px)
