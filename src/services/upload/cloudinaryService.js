import cloudinary from "../../configs/cloudinary.js";

const cloudinaryService = {
  uploadImage: (file) => {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "task_manager",
        },
        (error, result) => {
          if (error) {
            console.log("Cloudinary upload error:", error);
            return reject(
              new Error("Failed to upload image to Cloudinary")
            );
          }

          resolve(result.secure_url);
        }
      );

      stream.end(file.buffer);
    });
  },
};

export default cloudinaryService;