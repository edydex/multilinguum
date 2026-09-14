import { createRoot } from 'react-dom/client';
import { LiveExperience, type LiveExperienceOptions } from './LiveExperience';
import styles from './styles.css?inline';

export const clientVersion = 1;
/** Shared listener runtime. The host supplies only public, church-managed settings. */
export function mount(element: HTMLElement, options: LiveExperienceOptions): () => void {
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  const container = document.createElement('div');
  shadow.append(style, container);
  const root = createRoot(container);
  root.render(<LiveExperience {...options} />);
  return () => {
    root.unmount();
    shadow.replaceChildren();
  };
}
