import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { FavoritesPage } from '../pages/FavoritesPage';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/favorites',
  component: FavoritesPage,
});
