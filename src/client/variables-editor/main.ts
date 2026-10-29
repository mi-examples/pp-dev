// Entry of the Variables Editor bundle: its styles and page, built next to it in dist/client.
import './variables-editor.scss';
import './variables-editor.html';
import { startVariablesEditor } from './editor.js';

startVariablesEditor({ templateLess: document.body.dataset.templateLess === 'true' });
