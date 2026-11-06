// import mongoose from 'mongoose';

// const storeSchema = new mongoose.Schema(
//   {
//     name: { type: String, required: true, trim: true },
//     code: { type: String, required: true, unique: true, uppercase: true, trim: true },

//     type: {
//       type: String,
//       enum: ['store', 'warehouse'],
//       default: 'store',
//     },

//     address: {
//       line: { type: String, default: '' },
//       ward: { type: String, default: '' },
//       city: { type: String, default: '' },
//     },

//     /**
//      * Tọa độ địa lý - phục vụ query "tìm cửa hàng gần khách nhất"
//      * bằng $geoNear / $near. coordinates theo chuẩn GeoJSON: [lng, lat].
//      */
//     location: {
//       type: { type: String, enum: ['Point'], default: 'Point' },
//       coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
//     },

//     phone: { type: String, default: '' },
//     email: { type: String, default: '' },

//     // Có bán/hiển thị giá trực tiếp tại location này không
//     isSellable: { type: Boolean, default: true },

//     // Có cho khách đến nhận hàng tại đây không (click & collect / BOPIS)
//     isPickupPoint: { type: Boolean, default: true },

//     isDefault: { type: Boolean, default: false },
//     isActive: { type: Boolean, default: true },
//   },
//   { timestamps: true }
// );

// storeSchema.index({ isActive: 1 });
// storeSchema.index({ location: '2dsphere' });
// storeSchema.index({ type: 1, isSellable: 1, isActive: 1 });

// const Stores = mongoose.model('Stores', storeSchema);
// export default Stores;