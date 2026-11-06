// utils/uploadCloudinary.js

import cloudinary from "../configs/cloudinary.js";

export const uploadImageToCloudinary = (buffer, folder = "categories") => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) return reject(error);
        resolve(result); // result.secure_url, result.public_id
      }
    );
    stream.end(buffer);
  });
};
export const deleteImageFromCloudinary = (publicId) => {
  return new Promise((resolve, reject) => {
    if (!publicId) {
      return resolve(null);
    }

    cloudinary.uploader.destroy(
      publicId,
      { resource_type: "image" },
      (error, result) => {
        if (error) return reject(error);

        resolve(result);
      }
    );
  });
};