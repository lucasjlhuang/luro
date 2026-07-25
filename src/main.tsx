import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';

// StrictMode is intentionally omitted: its double-mount in dev would
// register the static PeerJS ID twice and trip 'unavailable-id'.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
