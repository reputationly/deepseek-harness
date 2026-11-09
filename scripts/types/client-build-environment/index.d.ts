/** Build-time values that bundlers replace before client code reaches a browser. */
declare const process: {
  readonly env: {
    readonly NODE_ENV?: string
    /** Product name the desktop build inlines into shell copy and window titles. */
    readonly DSH_DESKTOP_PRODUCT_NAME?: string
    /** Product gateway JSON the desktop build inlines into the shell. */
    readonly DSH_BRAND_GATEWAY?: string
    /** Product-owned Harness home directory name the desktop build inlines into the shell. */
    readonly DSH_BRAND_HOME_DIR?: string
    /** URL scheme the desktop build inlines for operating-system registration. */
    readonly DSH_BRAND_URL_SCHEME?: string
    readonly [name: `DSH_CLIENT_${string}`]: string | undefined
  }
}
