/**
 * Representation of the 'ImageContent' schema.
 */
export type ImageContent = {
    type: 'image_url';
    image_url: {
        url: string;
        /**
         * Default: "auto".
         */
        detail?: string;
    };
} & Record<string, any>;
//# sourceMappingURL=image-content.d.ts.map