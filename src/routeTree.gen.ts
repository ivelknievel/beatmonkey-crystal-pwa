import { Route as rootRoute } from './routes/__root';
import { Route as indexRoute } from './routes/index';
import { Route as discoverRoute } from './routes/discover';
import { Route as libraryRoute } from './routes/library';
import { Route as favoritesRoute } from './routes/favorites';
import { Route as settingsRoute } from './routes/settings';
import { Route as djDetailRoute } from './routes/djs.$id';
import { Route as festivalDetailRoute } from './routes/festivals.$slug';
import { Route as authCallbackRoute } from './routes/auth.callback';

export const routeTree = rootRoute.addChildren([
  indexRoute,
  discoverRoute,
  libraryRoute,
  favoritesRoute,
  settingsRoute,
  djDetailRoute,
  festivalDetailRoute,
  authCallbackRoute,
]);
