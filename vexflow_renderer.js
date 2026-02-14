// VexFlow-based renderStaff replacement for Charlie Parker's Mind

function renderStaff() {
    const svg = document.getElementById('staff-svg');
    svg.innerHTML = '';
    
    const fragment = state.currentFragment;
    if (!fragment || fragment.length === 0) return;
    
    const divisions = state.currentSongData?.divisions || 120;
    const timeSig = state.currentSongData?.timeSignature || { beats: 4, beatType: 4 };
    const keySig = state.currentSongData?.keySignature || { fifths: 0 };
    
    // MIDI to VexFlow key converter
    function midiToVexKey(midi) {
        const noteNames = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
        const noteName = noteNames[midi % 12];
        const octave = Math.floor(midi / 12) - 1;
        return noteName + '/' + octave;
    }
    
    // Duration type mapping
    function typeToVexDuration(type) {
        const map = {
            'whole': 'w',
            'half': 'h',
            'quarter': 'q',
            'eighth': '8',
            '16th': '16'
        };
        return map[type] || 'q';
    }
    
    // Check if note is dotted
    function isDotted(duration, divisions) {
        const quarterNote = divisions;
        return Math.abs(duration - quarterNote * 1.5) < 10 || 
               Math.abs(duration - quarterNote * 0.75) < 5;
    }
    
    // Create VexFlow renderer
    const VF = Vex.Flow;
    const renderer = new VF.Renderer(svg, VF.Renderer.Backends.SVG);
    
    // Calculate staff width based on fragment length
    const noteSpacing = 65;
    const leftMargin = 75;
    let estimatedWidth = leftMargin + fragment.length * noteSpacing + 100;
    
    renderer.resize(estimatedWidth, 200);
    const context = renderer.getContext();
    
    // Create stave with clef and time signature
    const stave = new VF.Stave(10, 40, estimatedWidth - 40);
    stave.addClef('treble');
    stave.addTimeSignature(`${timeSig.beats}/${timeSig.beatType}`);
    
    // Add key signature if present
    if (keySig.fifths !== 0) {
        const keyMap = {
            '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F',
            '0': 'C', '1': 'G', '2': 'D', '3': 'A', '4': 'E', '5': 'B', '6': 'F#', '7': 'C#'
        };
        const keyName = keyMap[keySig.fifths.toString()] || 'C';
        stave.addKeySignature(keyName);
    }
    
    stave.setContext(context).draw();
    
    // Build layout items (notes + rests for gaps)
    const layoutItems = [];
    const noteIndices = []; // Track which layoutItem corresponds to which fragment index
    
    for (let i = 0; i < fragment.length; i++) {
        // Check for gap before this note
        if (i > 0) {
            const prevEnd = fragment[i-1].startDiv + fragment[i-1].duration;
            const gap = fragment[i].startDiv - prevEnd;
            if (gap > 0) {
                // Add rest for gap
                const restType = gap >= divisions ? 'qr' : gap >= divisions/2 ? '8r' : '16r';
                layoutItems.push({ type: 'rest', duration: restType, fragmentIndex: -1 });
            }
        }
        
        const note = fragment[i];
        const userMidi = state.userPitches[i];
        
        // Rhythm mode: always use b/4 unless submitted or showing answer
        const showRealPitch = state.submitted || state.showingAnswer;
        const vexKey = showRealPitch ? midiToVexKey(userMidi) : 'b/4';
        const vexDuration = typeToVexDuration(note.type);
        
        const staveNote = new VF.StaveNote({
            keys: [vexKey],
            duration: vexDuration
        });
        
        // Add dot if needed
        if (isDotted(note.duration, divisions)) {
            staveNote.addDot(0);
        }
        
        // Add accidental if needed (only in answer mode)
        if (showRealPitch && needsAccidental(userMidi)) {
            const midi = userMidi % 12;
            const accidental = [1, 3, 6, 8, 10].includes(midi) ? '#' : null;
            if (accidental) {
                staveNote.addModifier(new VF.Accidental(accidental), 0);
            }
        }
        
        layoutItems.push({ type: 'note', vexNote: staveNote, fragmentIndex: i });
        noteIndices.push(i);
    }
    
    // Create voices and format
    const notes = layoutItems.map(item => item.type === 'rest' ? 
        new VF.StaveNote({ keys: ['b/4'], duration: item.duration }) : item.vexNote);
    
    const voice = new VF.Voice({ num_beats: timeSig.beats * 4, beat_value: timeSig.beatType });
    voice.setStrict(false);
    voice.addTickables(notes);
    
    // Format and draw
    const formatter = new VF.Formatter();
    const staveWidth = stave.getWidth() - stave.getModifierXShift();
    formatter.joinVoices([voice]).format([voice], staveWidth);
    voice.draw(context, stave);
    
    // Auto-beam eighth and sixteenth notes
    const beamableNotes = [];
    const beamableIndices = [];
    
    notes.forEach((note, i) => {
        const duration = note.getDuration();
        if (duration === '8' || duration === '16') {
            beamableNotes.push(note);
            beamableIndices.push(i);
        } else if (beamableNotes.length >= 2) {
            const beam = new VF.Beam(beamableNotes);
            beam.setContext(context).draw();
            beamableNotes.length = 0;
            beamableIndices.length = 0;
        } else {
            beamableNotes.length = 0;
            beamableIndices.length = 0;
        }
    });
    
    if (beamableNotes.length >= 2) {
        const beam = new VF.Beam(beamableNotes);
        beam.setContext(context).draw();
    }
    
    // Extract note positions for playhead
    state.notePositions = [];
    let noteCounter = 0;
    
    layoutItems.forEach((item, i) => {
        if (item.type === 'note') {
            const vexNote = notes[i];
            const x = vexNote.getAbsoluteX();
            state.notePositions[item.fragmentIndex] = x;
        }
    });
    
    // Apply Flipper Zero theme colors
    setTimeout(() => {
        const svgElement = svg.querySelector('svg');
        if (!svgElement) return;
        
        // Change all paths, lines, and rects to orange by default
        svgElement.querySelectorAll('path, line, rect').forEach(el => {
            if (el.getAttribute('fill') && el.getAttribute('fill') !== 'none') {
                el.setAttribute('fill', '#FF8C00');
            }
            if (el.getAttribute('stroke')) {
                el.setAttribute('stroke', '#FF8C00');
            }
        });
        
        // Color code notes based on state
        const noteElements = svgElement.querySelectorAll('.vf-notehead');
        noteElements.forEach((el, i) => {
            if (i < fragment.length) {
                const userMidi = state.userPitches[i];
                const correctMidi = fragment[i].midi;
                const isSelected = i === state.selectedNoteIndex;
                const isCorrect = userMidi === correctMidi;
                
                let color = '#FF8C00'; // default orange
                
                if (state.submitted) {
                    color = isCorrect ? '#00FF00' : '#FF4444';
                } else if (isSelected) {
                    color = '#FFFFFF';
                }
                
                // Apply color to notehead and related elements
                const parent = el.parentElement;
                parent.querySelectorAll('path, circle, rect, line').forEach(child => {
                    if (child.getAttribute('fill') && child.getAttribute('fill') !== 'none') {
                        child.setAttribute('fill', color);
                    }
                    if (child.getAttribute('stroke')) {
                        child.setAttribute('stroke', color);
                    }
                });
            }
        });
        
        // Draw selected note indicator if not submitted
        if (!state.submitted && state.selectedNoteIndex >= 0) {
            const selectedX = state.notePositions[state.selectedNoteIndex];
            if (selectedX) {
                const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const arrowY = 160;
                arrow.setAttribute('points', `${selectedX},${arrowY} ${selectedX - 6},${arrowY + 8} ${selectedX + 6},${arrowY + 8}`);
                arrow.setAttribute('fill', '#FFFFFF');
                svgElement.appendChild(arrow);
                
                // Note name tooltip
                const userMidi = state.userPitches[state.selectedNoteIndex];
                const noteName = midiToNoteName(userMidi, true);
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', selectedX);
                text.setAttribute('y', arrowY + 20);
                text.setAttribute('font-size', '10');
                text.setAttribute('fill', '#FFFFFF');
                text.setAttribute('text-anchor', 'middle');
                text.textContent = noteName;
                svgElement.appendChild(text);
            }
        }
        
        // Adjust SVG dimensions for horizontal scroll
        const bbox = svgElement.getBBox();
        const finalWidth = Math.max(estimatedWidth, bbox.width + 40);
        svgElement.setAttribute('width', finalWidth);
        svgElement.setAttribute('viewBox', `0 0 ${finalWidth} 200`);
        svg.style.minWidth = finalWidth + 'px';
    }, 10);
}
