-- 0003: the catalog. Where films play (cities, theatres, screens, seats), what plays
-- (movies), when (shows), at what price (show_prices), and the per-show seat
-- inventory that bookings compete for (show_seats).
--
-- Rules the database enforces, so no code path can break them:
--   * one theatre name per city, one screen name per theatre
--   * one seat per (row, number) and per grid position on a screen
--   * a show ends after it starts, and two scheduled shows never overlap on one screen
--   * prices are positive whole paise (ADR 0003)
--   * one inventory row per seat per show, and its hold columns match its status
--
-- Deletes: rows that bookings will depend on (movies, screens, shows, seats) use
-- ON DELETE RESTRICT; retire them with status/is_active instead. Pure child rows
-- (a screen's seats, a show's prices and inventory) cascade with their parent.

CREATE TABLE cities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL,
  state      text NOT NULL,
  -- Shows are stored in UTC; the city's zone decides what "today" means there.
  timezone   text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cities_slug_key UNIQUE (slug),
  CONSTRAINT cities_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE theatres (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id    uuid NOT NULL REFERENCES cities (id) ON DELETE RESTRICT,
  name       text NOT NULL,
  address    text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theatres_city_name_key UNIQUE (city_id, name)
);

CREATE TABLE screens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theatre_id uuid NOT NULL REFERENCES theatres (id) ON DELETE RESTRICT,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screens_theatre_name_key UNIQUE (theatre_id, name)
);

-- Global price tiers (Recliner, Prime, Classic). Each show sets its own price per tier.
CREATE TABLE seat_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  -- Display order in the seat map legend, cheapest last.
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seat_categories_name_key UNIQUE (name)
);

-- The physical seats of a screen. grid_x/grid_y place each seat on the seat map,
-- so aisles and gaps are just empty grid cells.
CREATE TABLE seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id   uuid NOT NULL REFERENCES screens (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES seat_categories (id) ON DELETE RESTRICT,
  row_label   text NOT NULL,
  seat_number integer NOT NULL,
  grid_x      integer NOT NULL,
  grid_y      integer NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seats_screen_row_number_key UNIQUE (screen_id, row_label, seat_number),
  CONSTRAINT seats_screen_grid_key UNIQUE (screen_id, grid_x, grid_y),
  CONSTRAINT seats_row_label_format CHECK (row_label ~ '^[A-Z]{1,2}$'),
  CONSTRAINT seats_seat_number_positive CHECK (seat_number > 0),
  CONSTRAINT seats_grid_non_negative CHECK (grid_x >= 0 AND grid_y >= 0)
);

CREATE TABLE movies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  language     text NOT NULL,
  duration_min integer NOT NULL,
  certificate  text,
  release_date date NOT NULL,
  description  text,
  poster_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- The same title can exist in several languages and as remakes in later years.
  CONSTRAINT movies_title_language_release_key UNIQUE (title, language, release_date),
  CONSTRAINT movies_duration_range CHECK (duration_min BETWEEN 1 AND 600)
);

-- ends_at is set by the API: start + movie duration + cleaning buffer.
CREATE TABLE shows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movie_id   uuid NOT NULL REFERENCES movies (id) ON DELETE RESTRICT,
  screen_id  uuid NOT NULL REFERENCES screens (id) ON DELETE RESTRICT,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'SCHEDULED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shows_status_valid CHECK (status IN ('SCHEDULED', 'CANCELLED')),
  CONSTRAINT shows_ends_after_start CHECK (ends_at > starts_at),
  -- Two scheduled shows can never occupy one screen at the same time. '[)' bounds
  -- make back-to-back shows legal: one may start exactly when the last one ends.
  -- Cancelled shows give their slot back.
  CONSTRAINT shows_no_overlap EXCLUDE USING gist (
    screen_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'SCHEDULED')
);

-- "What's playing in this city on this date" walks movie -> shows by start time.
CREATE INDEX shows_movie_starts_idx ON shows (movie_id, starts_at);

CREATE TABLE show_prices (
  show_id     uuid NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES seat_categories (id) ON DELETE RESTRICT,
  price_paise integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (show_id, category_id),
  CONSTRAINT show_prices_positive CHECK (price_paise > 0)
);

-- Seat inventory: one row per seat per show, created with the show. This is the
-- only place seat ownership lives; bookings in M2 change it with a conditional
-- UPDATE on these rows. M2 adds booking_id and widens the hold check to cover it.
CREATE TABLE show_seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id     uuid NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  seat_id     uuid NOT NULL REFERENCES seats (id) ON DELETE RESTRICT,
  -- Price copied from show_prices when the show is created, so later price edits
  -- never change what a held seat costs.
  price_paise integer NOT NULL,
  status      text NOT NULL DEFAULT 'AVAILABLE',
  held_until  timestamptz,
  -- Bumped on every status change; used by the optimistic hold strategy in M2.
  version     integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT show_seats_show_seat_key UNIQUE (show_id, seat_id),
  CONSTRAINT show_seats_status_valid
    CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED')),
  CONSTRAINT show_seats_positive_price CHECK (price_paise > 0),
  -- A hold always has an expiry, and only a hold has one.
  CONSTRAINT show_seats_hold_consistency CHECK ((status = 'HELD') = (held_until IS NOT NULL))
);

-- Seat map and availability counts for one show.
CREATE INDEX show_seats_show_status_idx ON show_seats (show_id, status);
-- The expiry sweeper (M2) scans only held seats, oldest expiry first.
CREATE INDEX show_seats_held_until_idx ON show_seats (held_until) WHERE status = 'HELD';

-- Keep updated_at current on every mutable table (function from 0002).
CREATE TRIGGER cities_set_updated_at BEFORE UPDATE ON cities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER theatres_set_updated_at BEFORE UPDATE ON theatres
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER screens_set_updated_at BEFORE UPDATE ON screens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER seat_categories_set_updated_at BEFORE UPDATE ON seat_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER seats_set_updated_at BEFORE UPDATE ON seats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER movies_set_updated_at BEFORE UPDATE ON movies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shows_set_updated_at BEFORE UPDATE ON shows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER show_prices_set_updated_at BEFORE UPDATE ON show_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER show_seats_set_updated_at BEFORE UPDATE ON show_seats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
