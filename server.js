require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const db = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Orders are stored in Postgres (see db.js). Set DATABASE_URL and they survive
// restarts and redeploys; leave it unset and db.js falls back to memory for
// local testing only.

function requireAdmin(req, res) {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.query.key !== adminKey) {
    res.status(401).json({ error: 'Missing or incorrect admin key.' });
    return false;
  }
  return true;
}

app.post('/orders', async (req, res) => {
  const { childName, childCount, email, theme, notes, thumb, pageCount } = req.body || {};
  if (!childName || !email) {
    return res.status(400).json({ error: 'Missing childName or email.' });
  }
  try {
    const order = await db.saveOrder({
      childName: String(childName).slice(0, 200),
      childCount: Math.min(Math.max(parseInt(childCount, 10) || 1, 1), 3),
      email: String(email).slice(0, 320),
      theme: theme || 'Portrait',
      notes: String(notes || '').slice(0, 1000),
      thumb: thumb || null,
      pageCount: parseInt(pageCount, 10) || 0
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error('Failed to save order:', err);
    res.status(500).json({ error: 'Could not save the order. Please try again.' });
  }
});

app.get('/orders', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const includeThumbs = req.query.thumbs === '1';
    const orders = await db.listOrders({ limit, includeThumbs });
    res.json({ orders, count: await db.countOrders(), storage: db.usingPostgres ? 'postgres' : 'memory' });
  } catch (err) {
    console.error('Failed to list orders:', err);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// Single order, thumbnail included — for opening one order in the admin view.
app.get('/orders/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const order = await db.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order });
  } catch (err) {
    console.error('Failed to load order:', err);
    res.status(500).json({ error: 'Could not load the order.' });
  }
});

const ORDER_STATUSES = ['new', 'in_progress', 'delivered', 'cancelled'];

app.post('/orders/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const status = (req.body && req.body.status) || '';
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status must be one of: ' + ORDER_STATUSES.join(', ') });
  }
  try {
    const order = await db.updateOrderStatus(req.params.id, status);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ success: true, order });
  } catch (err) {
    console.error('Failed to update order:', err);
    res.status(500).json({ error: 'Could not update the order.' });
  }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. Add it as an environment variable before deploying.');
}

const BASE_STYLE = 'Black and white coloring book page, clean bold outlines only, no shading, no gray tones, no text or captions, simple line art suitable for a child to color in.';

function subjectPhrase(count, subjectType) {
  const noun = subjectType === 'adult' ? 'people' : 'children';
  const singularNoun = subjectType === 'adult' ? 'the person' : 'the child';
  if (count >= 3) return 'all three ' + noun;
  if (count === 2) return 'both ' + noun;
  return singularNoun;
}

function consistencyLine(count, subjectType) {
  const possessive = subjectType === 'adult' ? 'person\'s' : 'child\'s';
  if (count > 1) {
    return 'The reference photo shows ' + subjectPhrase(count, subjectType) + '. Keep each ' + possessive + ' individual likeness consistent across every scene, and show them together, interacting, in every scene.';
  }
  return 'Keep the likeness of ' + subjectPhrase(count, subjectType) + ' from the reference photo consistent across the whole story.';
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
  ],
  'Grandparent Garden': [
    'the child watering flowers in a backyard garden',
    'the child kneeling beside a row of vegetable plants, trowel in hand',
    'the child holding up a freshly picked tomato, smiling proudly',
    'the child planting a small tree together with a watering can nearby',
    'the child sitting on a porch swing surrounded by potted plants',
    'the child picking flowers for a bouquet',
    'the child feeding birds at a garden birdfeeder',
    'the child resting in a garden hammock under a shady tree',
    'the child arranging cut flowers into a vase at an outdoor table',
    'the child walking through a sunflower patch',
    'the child harvesting apples from a small tree',
    'the child sitting at a garden table having tea',
    'the child raking autumn leaves into a pile in the yard',
    'the child admiring a rainbow over the garden after rain',
    'the child waving from the garden gate at golden hour'
  ],
  'Family Keepsake': [
    'the child baking cookies in a cozy kitchen, apron on',
    'the child reading a storybook aloud in an armchair by a window',
    'the child stirring a pot of soup on the stove',
    'the child setting the table for a family dinner',
    'the child knitting or working on a craft at a table',
    'the child looking through an old photo album on a couch',
    'the child playing a board game at the kitchen table',
    'the child decorating a holiday tree with ornaments',
    'the child rocking gently in a rocking chair with a cup of tea',
    'the child tending a warm fireplace in a cozy living room',
    'the child wrapping a gift at a table covered in ribbon',
    'the child walking hand in hand with a grandchild in the park',
    'the child sitting on a porch swing watching the sunset',
    'the child blowing out candles on a birthday cake',
    'the child waving warmly from a front porch, welcoming guests'
  ]
};

function buildPrompt(theme, sceneIndex, childCount, subjectType, notes) {
  const scenes = STORY_SCENES[theme] || STORY_SCENES['Portrait'];
  let scene = scenes[sceneIndex] || scenes[0];
  scene = scene.replace(/\bthe child\b/g, subjectPhrase(childCount, subjectType));
  let prompt = `${BASE_STYLE} ${consistencyLine(childCount, subjectType)} Scene: ${scene}.`;
  if (notes && notes.trim()) {
    prompt += ` Also incorporate this detail where it fits naturally: ${notes.trim()}.`;
  }
  return prompt;
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
    const subjectType = req.body.subjectType === 'adult' ? 'adult' : 'kid';
    const notes = (req.body.notes || '').slice(0, 300);
    const prompt = buildPrompt(theme, sceneIndex, childCount, subjectType, notes);

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

// Simple health check — also reports which storage engine is live, so you can
// tell at a glance whether DATABASE_URL actually took effect on Render.
app.get('/health', async (req, res) => {
  try {
    const count = await db.countOrders();
    res.json({ ok: true, storage: db.usingPostgres ? 'postgres' : 'memory', orders: count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

db.initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Could not initialise the database:', err);
    process.exit(1);
  });
