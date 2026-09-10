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

const BASE_STYLE = 'Black and white coloring book page, clean bold outlines only, no shading, no gray tones, no text or captions, simple line art suitable for a child to color in.';

function subjectPhrase(childCount) {
  if (childCount >= 3) return 'all three children';
  if (childCount === 2) return 'both children';
  return 'the child';
}

function consistencyLine(childCount) {
  if (childCount > 1) {
    return 'The reference photo shows ' + subjectPhrase(childCount) + '. Keep each child\'s individual likeness consistent across every scene, and show them together, interacting, in every scene.';
  }
  return 'Keep the likeness of the child from the reference photo consistent across the whole story.';
}

const STORY_SCENES = {
  'Superhero': [
    'the child discovers a glowing cape in their bedroom',
    'the child puts on the cape and a mask for the first time, looking in a mirror',
    'the child leaps off a rooftop, cape flying, starting to fly',
    'the child soars above city skyscrapers for the first time',
    'the child rescues a kitten stuck in a tall tree',
    'the child races a speeding runaway train and slows it down',
    'the child lifts a fallen tree off a road to clear the way',
    'the child faces down a cartoonish storm cloud villain in the sky',
    'the child uses super strength to hold up a collapsing bridge',
    'the child teams up with a friendly robot sidekick',
    'the child flies through a lightning storm, unafraid',
    'the child is cheered on by a crowd of grateful city people',
    'the child stands on a rooftop at sunset, cape blowing in the wind',
    'the child helps an elderly person cross a busy street',
    'the child flies home at night under a starry sky, mission complete'
  ],
  'Adventure scene': [
    'the child finds an old treasure map in a jungle clearing',
    'the child sets off into the jungle with a backpack and compass',
    'the child crosses a rope bridge over a river',
    'the child meets a friendly dinosaur for the first time',
    'the child rides on the dinosaur\'s back through tall ferns',
    'the child and the dinosaur discover a hidden waterfall',
    'the child climbs a rocky cliff beside the dinosaur',
    'the child and the dinosaur are caught in a sudden jungle rainstorm',
    'the child discovers ancient stone ruins covered in vines',
    'the child solves a puzzle carved into a stone door',
    'the child and the dinosaur enter a hidden cave full of crystals',
    'the child finds a treasure chest glowing with light',
    'the child and the dinosaur are chased by a friendly flock of birds',
    'the child says goodbye to the dinosaur at the edge of the jungle',
    'the child walks home at sunset holding the treasure, jungle behind them'
  ],
  'Fairy tale': [
    'the child finds a glowing door hidden in an old oak tree',
    'the child steps through the door into an enchanted forest',
    'the child meets a small talking fox who offers to be their guide',
    'the child and the fox follow a path of glowing mushrooms',
    'the child discovers a castle in the distance, towers glowing in mist',
    'the child crosses a bridge guarded by a friendly dragon',
    'the child and the dragon become friends and share a laugh',
    'the child is welcomed into the castle by kind fairy folk',
    'the child dances at a fairy tale ball in the castle hall',
    'the child helps break a spell on a sleeping garden',
    'the flowers and trees in the garden bloom back to life',
    'the child rides the dragon over the treetops of the enchanted forest',
    'the child and the fox watch the sunset from a castle tower',
    'the child is given a small glowing charm as a keepsake',
    'the child walks back through the glowing door, waving goodbye'
  ],
  'Portrait': [
    'a simple front-facing portrait of the child smiling',
    'a portrait of the child laughing, head tilted slightly',
    'a portrait of the child with their favorite toy',
    'a portrait of the child looking curiously to one side',
    'a portrait of the child mid-jump, joyful',
    'a portrait of the child reading a book',
    'a portrait of the child with arms stretched out wide',
    'a portrait of the child wearing a fun hat',
    'a portrait of the child giving a thumbs up',
    'a portrait of the child blowing a kiss',
    'a portrait of the child with a big surprised expression',
    'a portrait of the child mid-spin, twirling',
    'a portrait of the child waving hello',
    'a portrait of the child hugging a stuffed animal',
    'a portrait of the child taking a bow'
  ]
};

function buildPrompt(theme, sceneIndex, childCount) {
  const scenes = STORY_SCENES[theme] || STORY_SCENES['Portrait'];
  let scene = scenes[sceneIndex] || scenes[0];
  if (childCount > 1) {
    scene = scene.replace(/\bthe child\b/g, subjectPhrase(childCount));
  }
  return `${BASE_STYLE} ${consistencyLine(childCount)} Scene: ${scene}.`;
}

app.get('/story-length', (req, res) => {
  const theme = req.query.theme || 'Portrait';
  const scenes = STORY_SCENES[theme] || STORY_SCENES['Portrait'];
  res.json({ theme, sceneCount: scenes.length });
});

app.post('/convert', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded.' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing its OpenAI API key.' });
    }

    const theme = req.body.theme || 'Portrait';
    const sceneIndex = parseInt(req.body.sceneIndex, 10) || 0;
    let childCount = parseInt(req.body.childCount, 10) || 1;
    childCount = Math.min(Math.max(childCount, 1), 3);
    const prompt = buildPrompt(theme, sceneIndex, childCount);

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

    res.json({ image: `data:image/png;base64,${b64}`, sceneIndex });
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
