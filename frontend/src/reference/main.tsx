// The reference page's entry: ?theme=light|dark and ?layout=desktop|phone choose what it draws.
import { createRoot } from 'react-dom/client';
import { Reference } from './Reference';
import '../ui/styles/index.css';
import './reference.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
createRoot(document.getElementById('root')!).render(<Reference layout={params.get('layout') === 'phone' ? 'phone' : 'desktop'} />);
