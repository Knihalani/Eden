/** Ambient types for rrweb-player (F09 / W15). */
declare module "rrweb-player" {
  export default class rrwebPlayer {
    constructor(options: {
      target: HTMLElement;
      props: {
        events: unknown[];
        width?: number;
        height?: number;
        autoPlay?: boolean;
        showController?: boolean;
      };
    });
    $destroy?: () => void;
    goto?: (timeOffset: number) => void;
  }
}

declare module "rrweb-player/dist/style.css";
