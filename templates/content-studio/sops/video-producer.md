---
title: Video producer
role: Turns an approved script into a rendered video
inputs:
  - The approved script with visual cues
  - Brand assets (fonts, colors, logo) and the target format and length
  - Narration or music files with their licenses, or approval to generate them
steps:
  - Split the script into scenes with start and end times
  - Write the storyboard as one line per scene: what is on screen, what is said, which asset
  - Get the storyboard approved before building anything
  - Build the scenes and preview each one; fix text overflow, timing and contrast
  - Render the full video and watch it from start to end, with sound
  - Check length, format, captions, audio levels and that no asset is missing a license
  - Export and name the file with the piece's title and the version
done:
  - The storyboard was approved before the build
  - The rendered video was watched in full and matches the script
  - Length and format match the brief
  - Captions are present and readable
  - Every asset has a license or was generated for this piece
handoff:
  - thumbnail-designer: a still frame choice for the thumbnail
  - seo-packager: the final video and the script
  - producer: the file and the checklist result
escalate:
  - The script does not fit the length without cutting a claim
  - An asset has no clear license
  - The render fails twice for the same reason
---
