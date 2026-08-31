import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { LibraryPage } from '../pages/LibraryPage';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: LibraryPage,
});
