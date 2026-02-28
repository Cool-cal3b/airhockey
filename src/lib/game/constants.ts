export const RINK_WIDTH = 400;
export const RINK_HEIGHT = 700;
export const CANVAS_PADDING = 50;
export const CANVAS_WIDTH = RINK_WIDTH + CANVAS_PADDING * 2;
export const CANVAS_HEIGHT = RINK_HEIGHT + CANVAS_PADDING * 2;
export const PADDLE_RADIUS = 30;
export const PUCK_RADIUS = 18;
export const GOAL_WIDTH = 120;
export const CORNER_RADIUS = 30;
export const CENTER_CIRCLE_RADIUS = 60;

export const PUCK_MAX_SPEED = 1200;
export const PUCK_FRICTION = 0.5;
export const PADDLE_MAX_SPEED = 4000;

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

export const COUNTDOWN_SECONDS = 3;
export const GOAL_RESET_DELAY_MS = 1500;

export const GOAL_X_MIN = (RINK_WIDTH - GOAL_WIDTH) / 2;
export const GOAL_X_MAX = (RINK_WIDTH + GOAL_WIDTH) / 2;
