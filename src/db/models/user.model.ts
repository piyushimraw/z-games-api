import { Schema, model } from 'mongoose';
import * as uniqueValidator from 'mongoose-unique-validator';

const transform = (doc, ret, options) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
};

export const userSchema = new Schema({
  firstName: String,
  lastName: String,
  email: { type: String, unique: true },
  password: String,
  username: { type: String, unique: true },
  isConfirmed: Boolean,
  provider: String,
  avatar: String,
  openedGame: { type: Schema.Types.ObjectId, ref: 'Game' },
  currentGames: [{ type: Schema.Types.ObjectId, ref: 'Game' }],
  currentWatch: { type: Schema.Types.ObjectId, ref: 'Game' },
  currentMove: [{ type: Schema.Types.ObjectId, ref: 'Game' }],
  gamesPlayed: { type: Number, required: true, default: 0 },
  gamesWon: { type: Number, required: true, default: 0 },
  createdAt: { type: Date, required: true, default: new Date() },
  updatedAt: { type: Date, required: true, default: new Date() },
  logs: [{ type: Schema.Types.ObjectId, ref: 'Log' }],
}, {
    toJSON: { transform },
    toObject: { transform },
  });

userSchema.plugin(uniqueValidator);

userSchema.pre('update', next => {
  this.update({}, {
    $set: {
      updatedAt: new Date(),
    },
  });
  next();
});

export const UserMongo = model('User', userSchema);