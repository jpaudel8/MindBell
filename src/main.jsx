import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

console.log("Awareness App: Initializing...");

const rootElement = document.getElementById('root');

try {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  console.log("Awareness App: Rendered successfully.");
} catch (error) {
  console.error("Awareness App: Render failed!", error);
  rootElement.innerHTML = `
    <div style="padding: 20px; color: #ff4444; background: #1a0000; font-family: monospace; border: 1px solid red; margin: 20px;">
      <h3>Render Error Detected</h3>
      <pre>${error.stack}</pre>
    </div>
  `;
}
