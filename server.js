require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. Add it as an environment variable before deploying.');
}

const STYLE_PROMPTS = {
  'Portrait': 'A simple black and white coloring book page portrait of this child. Clean bold outlines only, no shading, no gray tones, white background, simple line art suitable for a child to color in. Keep the likeness and pose.',
  'Adventure scene': 'A black and white coloring book page showing this child on a jungle adventure, riding a friendly dinosaur. Clean bold outlines only, no shading, no gray tones, suitable for a child to color in. Keep the likeness of the child.',
  'Superhero': 'A black and white coloring book page showing this child as a superhero, cape flying, soaring through the sky above a city. Clean bold outlines only, no shading, no gray tones, suitable for a child to color in. Keep the likeness of the child.',
  'Fairy tale': 'A black and white coloring book page showing this child as a fairy tale character in an enchanted forest with castle in the background. Clean bold outlines only, no shading, no gray tones, suitable for a child to color in. Keep the likeness of the child.'
};

app.post('/convert', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded.' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing its OpenAI API key.' });
    }

    const theme = req.body.theme || 'Portrait';
    const prompt = STYLE_PROMPTS[theme] || STYLE_PROMPTS['Portrait'];

    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    form.append('size', '1024x1024');
    form.append('quality', 'medium');
    form.append('image', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'photo.png');

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenAI error:', data);
      const message = (data.error && data.error.message) || 'Unknown error from OpenAI.';
      return res.status(502).json({ error: 'Image conversion failed.', detail: message });
    }

    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      return res.status(502).json({ error: 'No image returned from OpenAI.' });
    }

    res.json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error converting image.' });
  }
});

app.get('/', (req, res) => {
  res.send('Coloring book conversion server is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
