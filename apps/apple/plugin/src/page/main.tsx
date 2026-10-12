import { createRoot } from 'react-dom/client';

import { Page } from './page.tsx';

const root = document.getElementById('root');
if (root === null) throw new Error('page.html has no #root element.');
createRoot(root).render(<Page />);
