import { createRoot } from 'react-dom/client';
import { ManagedOperator, type ManagedOperatorOptions } from './ManagedOperator';
import styles from './managed.css?inline';
export const clientVersion = 1;
export const servicePlanVersion = 1;
export function mount(element: HTMLElement, options: ManagedOperatorOptions): () => void {
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  const container = document.createElement('div');
  shadow.append(style, container);
  const root = createRoot(container);
  root.render(<ManagedOperator {...options} />);
  return () => {
    root.unmount();
    shadow.replaceChildren();
  };
}
