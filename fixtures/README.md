# Fixtures

- `photos/`: **placeholder** item photos (SVG) for the offline demo sweep. Replace with real photos of the team's items (JPEG/PNG; EXIF is stripped on upload). The filename doubles as the offline identifier's hint, e.g. `01-jogging-stroller.jpg`.
- `footage/`: labelled porch stills played as "the camera" (judge-approved simulator path). Add files and list them in `index.json`:

```json
{ "item_present": [{ "file": "porch-stroller-01.jpg", "label": "present" }],
  "item_absent":  [{ "file": "porch-empty-01.jpg", "label": "absent" }],
  "unclear":      [{ "file": "porch-glare-01.jpg", "label": "unsure" }] }
```

Every frame from here is labelled "Our footage" in the UI and on receipts (`origin: our_footage`). Without files, labelled placeholder frames are generated.
