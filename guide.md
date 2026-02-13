I am building a web music score editor.(pitch only) 
1, it can load mxl files.
2, it can edit the pitch of notes. But we don't need to edit the duration of notes.
3, User can use arrow keys to change the pitch of notes. Left and right to chose the note, up and down to change the pitch.
4, it can export the edited mxl files.

## Questions

- __MXL specifics__: Should we support both compressed `.mxl` and uncompressed `.musicxml`? Any version constraints of MusicXML (e.g., 3.0 vs 4.0)?
Yes, we should support both.
- __Loading scope__: Will scores include multiple parts/voices, chords, ties, and rests? If a chord is selected, should up/down move all notes in the chord or only one head?
Only monophonic notes, like leadsheet sytle. 
- __Selection model__: When using left/right, do we navigate noteheads sequentially across voices and staves, or stay within the current voice/staff/measure? How are tied notes handled (select tie group as one or individual notes)?
Tied notes handled like one note.
- __Pitch stepping__: Should up/down be diatonic steps within the current key signature (scale degrees) or chromatic semitone steps? Is there a modifier (e.g., Shift/Ctrl) for the alternate mode?
Half-step chromatic steps. Sharp and flat depends on the direction it came from, going up is sharp, going down is flat.
- __Octave behavior__: How to handle crossing staff lines/ledger lines—should diatonic up from B go to C next octave automatically? Any accelerator for octave up/down (e.g., Alt+Up/Down)?
1,Treble clef only, range from C3 to F6, clamp. accelerator for octave up/down is CMD+UP/CMD+DOWN.
- __Accidentals and spelling__: If stepping chromatically, should we preserve enharmonic spelling or re-spell based on key/context (e.g., G# vs Ab)? Any user control to toggle enharmonic spelling?
don't worry about the key, just follow the direction user just used. Like musescore does.
- __Key/time signatures__: Will we need to display and respect key signatures when computing accidentals? Are transposing instruments in scope?
Just like musescore does. No transposing instruments. We have concert pitch only.
- __Constraints__: Are there limits to avoid illegal pitches (e.g., below instrument range)? Should we clamp or allow any MIDI 0–127?
Range range from C3 to F6, clamp.
- __UI/UX__: Minimal viewer only, or full notation rendering? Preferred rendering library (e.g., VexFlow, OpenSheetMusicDisplay, Verovio)? Any design/style guidelines?
I will let you decide. For the style, simple is better.
- __Keyboard focus__: Should arrow keys work only when the score canvas is focused? Any conflicts with page scrolling; should we prevent default browser behavior?
Yes, we prevent default browser behavior. The score canvas is the only element that can be focused, and it will always be focused.
- __Persistence__: On export, maintain original layout/engraving data or only musical content? Overwrite source file or prompt for a new download name/location?
Export maintain everything like before, only change is the pitch. 
- __Performance__: Target max score size (measures/parts) to guide optimization?
Check what musescore does.
- __Testing files__: Do you have sample `.mxl` files (edge cases: multiple voices, chords, ties, key changes) we should use during development?
/Users/tianxing/Documents/NYU/MusicCode/WebMusicScoreEditor/Test.mxl
- __Non-goals confirmation__: No duration edits—does this also exclude insert/delete notes, tuplets, and re-beaming? Any future feature we should keep in mind?
No delete or insert notes, no tuplets, no re-beaming. This is a pitch editor.


## Further Questions

- __MusicXML versions__: Any minimum/maximum MusicXML version we must support (e.g., 3.1+, 4.0)? Export should match the original input type (`.mxl` vs `.musicxml`), correct?
3.1 and 4.0 are both need. Export should match the original input type.
- __Initial selection__: After loading a score, which note is initially selected? First note of the first measure? Remembering last selection on re-open is out of scope?
First note of the first measure. Remembering last selection is good.
- __Left/Right navigation__: Should left/right skip rests or land on them? If landing on rests is allowed, do arrow up/down on a rest do nothing, or should we skip to the next note instead?
Left/right not skip rests, just not editale. Arrow up/down on a rest do nothing. 
- __Navigation wrap__: At start/end of the score, should navigation wrap around (end to start) or stop? Crossing measures with left/right is allowed, correct?
 At start/end of the score, navigatio will stop, no warp. Crossing measures with left/right is allowed
- __Grace notes/ornaments__: If present in the file, should we ignore them for navigation/edits, or allow selection but disallow pitch changes? (Monophonic leadsheet suggests ignore.)
Ignore them for navigation/edits.
- __Accidental normalization__: When reversing direction (e.g., went up to G#, then go down), should we strictly mirror steps (G# -> G natural) or re-spell to flats when going down (G# -> G -> Gb)? Follow MuseScore exactly?
(G# -> G -> Gb)is correct.Follow musescore exactly.
- __CMD vs Ctrl__: On non-mac systems, should CMD+Up/Down map to Ctrl+Up/Down for octave changes, or mac-only is sufficient for now?
Mac only is sufficient for now.
- __Error handling UX__: If an invalid/corrupt file is loaded, do we show a simple error banner/modal with a retry button? Any preference?
Simple error banner/modal with a retry button is good.
- __Autosave__: No autosave required, correct? Only explicit export triggers writing a file.
No autosave required.
- __Preserving metadata__: On export, we should keep all non-pitch XML (layout, page, credits, tempo, dynamics) unchanged. Is it acceptable if internal zip ordering or whitespace differs, as long as musical content and layout render identical?
Keep all non-pitch XML (layout, page, credits, tempo, dynamics) unchanged.


