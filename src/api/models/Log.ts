import { IsNotEmpty } from 'class-validator';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Game } from '../models/Game';
import { User } from '../models/User';

@Entity()
export class Log {

  @PrimaryColumn('uuid')
  public id: string;

  @IsNotEmpty()
  @Column()
  public type: string;

  @IsNotEmpty()
  @Column()
  public text: string;

  @IsNotEmpty()
  @Column({ name: 'game_id', nullable: false })
  public gameId: string;

  @IsNotEmpty()
  @Column({ name: 'user_id', nullable: false })
  public userId: string;

  @IsNotEmpty()
  @CreateDateColumn({ name: 'created_at' })
  public createdAt: Date;

  @IsNotEmpty()
  @ManyToOne(type => Game, game => game.logs)
  @JoinColumn({ name: 'game_id' })
  public game: Game;

  @IsNotEmpty()
  @ManyToOne(type => User, user => user.logs)
  @JoinColumn({ name: 'user_id' })
  public user: User;

  public toString(): string {
    return `${this.text}`;
  }

}
