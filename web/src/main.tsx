import { render } from 'preact';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/roboto-mono/latin-400.css';
import '@fontsource/roboto-mono/latin-500.css';
import './styles/base.css';
import './styles/table.css';
import './styles/panels.css';
import './styles/depth.css';
import './styles/belief.css';
import { App } from './ui/App';
import { BotClient } from './bot/client';
import { initSound } from './game/sound';

const params = new URLSearchParams(location.search);
// `embed=portfolio` was the previous frontend's flag; keep it working.
const embed = ['1', 'true', 'portfolio'].includes(params.get('embed') ?? '');
const autoplay = params.get('autoplay') === '1';
if (embed) document.documentElement.classList.add('embed');
initSound({ embed });

const bot = new BotClient();
render(<App bot={bot} embed={embed} autoplay={autoplay} />, document.getElementById('root')!);
