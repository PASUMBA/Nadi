# Nadi

## Heart Rate from Face

Nadi estimates a heart rate from small colour changes in your face. It runs in
Chrome and processes the camera image on your device.

Live page: <https://pasumba.github.io/Nadi/>

## How to use

1. Open the live page in Chrome and allow camera access.
2. Sit 40–60 cm from the camera, facing a light source.
3. Keep your face in view and sit still.
4. Wait about 15 seconds for a reading.
5. Tap **Stop** when you are done.

For best results, use frontal lighting of at least 300 lux and a camera running
at 30 fps or faster. The reading is an estimate, not a medical measurement.
Nadi is not a medical device.

## How it works

- A face mesh finds the face.
- Forehead and cheek skin regions are selected.
- Their average colour is measured in each frame.
- The POS method separates the pulse-like colour signal.
- An FFT peak in the heart-rate range is converted to BPM.

Your video stays on your device and is not uploaded.
