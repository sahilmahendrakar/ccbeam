# Re-record the README demo:  vhs docs/demo/demo.tape   (run from the repo root)
#
# Needs vhs, ttyd and ffmpeg. What plays is docs/demo/demo.sh — a re-enactment,
# not a capture; see the header of that file.

Output docs/demo/ccbeam.gif

Require bash

Set Shell bash
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 1000
Set Height 620
Set Padding 20
Set Framerate 20
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

# Set the scene off-camera: a prompt that says where we are, and the shell
# integration ccbeam installs, so what gets typed on camera is just `claude`.
Hide
Type `export PS1='\[\e[38;5;245m\]~/dev/api\[\e[0m\] ❯ '; claude() { bash docs/demo/demo.sh; }`
Enter
Type "clear"
Enter
Show

Sleep 800ms
Type "claude"
Sleep 700ms
Enter

Sleep 22s
