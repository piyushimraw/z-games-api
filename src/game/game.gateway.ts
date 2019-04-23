import { UseGuards } from '@nestjs/common';
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WsResponse,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GAME_FINISHED } from 'z-games-base-game';

import { GameService } from './game.service';
import { UserService } from '../user/user.service';
import { InviteService } from '../invite/invite.service';
import { LogService } from '../log/log.service';
import { LoggerService } from '../logger/logger.service';
import { JwtGuard } from '../guards/jwt.guard';
import { JwtService } from '../services/jwt.service';
import { Game, User, Log, Invite } from '../db/entities';
import { IFilterSettings } from './IFilterSettings.interface';
import { IGame, IUser, IInvite } from '../db/interfaces';

@WebSocketGateway()
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {

  @WebSocketServer()
  server: Server;

  private disconnectTimers: { [key: string]: NodeJS.Timeout } = {};
  private connectTimers: { [key: string]: NodeJS.Timeout } = {};

  constructor(
    private readonly gameService: GameService,
    private readonly userService: UserService,
    private readonly inviteService: InviteService,
    private readonly logService: LogService,
    private readonly logger: LoggerService,
    private readonly jwtService: JwtService,
  ) { }

  async handleConnection(client: Socket) {
    const token = client.handshake.query.token;

    if (this.connectTimers[token]) {
      return;
    }

    this.connectTimers[token] = setTimeout(async () => {
      delete this.connectTimers[token];
    }, 4000);

    const userId = this.jwtService.getUserIdByToken(token);

    const user = await this.userService.findOneByUserId(userId);

    if (!user) {
      return;
    }

    if (!user.openedGame) {
      return;
    }

    client.join(user.openedGame.id);

    if (this.disconnectTimers[user.id]) {
      clearTimeout(this.disconnectTimers[user.id]);
      delete this.disconnectTimers[user.id];
      return;
    }

    await this.logService.create({
      type: 'connect',
      user,
      gameId: user.openedGame.id,
    });

    const game = JSON.parse(JSON.stringify(await this.gameService.findOne(user.openedGame.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    this.server.emit(
      'update-game',
      this.gameService.parseGameForAllUsers(game),
    );
  }

  async handleDisconnect(client: Socket) {
    const token = client.handshake.query.token;

    const userId = this.jwtService.getUserIdByToken(token);

    const user = await this.userService.findOneByUserId(userId);

    if (!user) {
      return;
    }

    if (!user.openedGame) {
      return;
    }

    this.disconnectTimers[user.id] = setTimeout(async () => {

      await this.logService.create({
        type: 'disconnect',
        user,
        gameId: user.openedGame.id,
      });

      client.leave(user.openedGame.id);

      const game = JSON.parse(JSON.stringify(await this.gameService.findOne(user.openedGame.number)));

      this.sendGameToGameUsers({ server: this.server, game });
      this.server.emit(
        'update-game',
        this.gameService.parseGameForAllUsers(game),
      );

      delete this.disconnectTimers[user.id];
    }, 4000);
  }

  @SubscribeMessage('get-all-games')
  async getAllGames(
    client: Socket & { user: User },
    filterSettings: IFilterSettings,
  ): Promise<WsResponse<Game[]>> {
    return {
      event: 'all-games',
      data: await this.gameService.getAllGames(filterSettings),
    };
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('get-opened-game')
  public async getOpenedGame(
    client: Socket & { user: User },
  ): Promise<WsResponse<Game>> {
    if (!client.user) {
      return;
    }

    if (!client.user.openedGame && !client.user.currentWatch) {
      return;
    }

    const gameNumber = client.user.openedGame
      ? client.user.openedGame.number
      : client.user.currentWatch.number;
    const game = JSON.parse(
      JSON.stringify(await this.gameService.findOne(gameNumber)),
    );

    client.join(game.id);

    return {
      event: 'update-opened-game',
      data: this.gameService.parseGameForUser({ game, user: client.user }),
    };
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('new-game')
  public async newGame(
    client: Socket & { user: User },
    name: string,
  ): Promise<Game> {
    let game: Game;

    try {
      game = await this.gameService.newGame(name, client.user.id);
    } catch (error) {
      this.sendError({ client, message: error.response.message });
      return;
    }

    try {
      await this.logService.create({
        type: 'create',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      this.sendError({ client, message: error.response.message });
      return;
    }

    this.server.emit('new-game', this.gameService.parseGameForAllUsers(game));

    await this.joinGame(client, game.number);

    return game;
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('join-game')
  public async joinGame(
    client: Socket & { user: User },
    gameNumber: number,
  ): Promise<void> {
    let game: Game;

    try {
      game = await this.gameService.joinGame({ user: client.user, gameNumber });
    } catch (error) {
      client.emit('');
      return this.sendError({ client, message: error.response.message });
    }

    try {
      await this.logService.create({
        type: 'join',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    client.join(game.id);

    game = JSON.parse(JSON.stringify(await this.gameService.findOne(game.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    this.server.emit(
      'update-game',
      this.gameService.parseGameForAllUsers(game),
    );
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('open-game')
  public async openGame(
    client: Socket & { user: User },
    gameNumber: number,
  ): Promise<void> {
    let game: Game;

    try {
      game = await this.gameService.openGame({ user: client.user, gameNumber });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    try {
      await this.logService.create({
        type: 'open',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    client.join(game.id);

    game = JSON.parse(JSON.stringify(await this.gameService.findOne(game.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    this.server.emit(
      'update-game',
      this.gameService.parseGameForAllUsers(game),
    );
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('watch-game')
  public async watchGame(
    client: Socket & { user: User },
    gameNumber: number,
  ): Promise<void> {
    let game: Game;

    try {
      game = await this.gameService.watchGame({
        user: client.user,
        gameNumber,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    try {
      await this.logService.create({
        type: 'watch',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    client.join(game.id);

    game = JSON.parse(JSON.stringify(await this.gameService.findOne(game.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    this.server.emit(
      'update-game',
      this.gameService.parseGameForAllUsers(game),
    );
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('leave-game')
  public async leaveGame(
    client: Socket & { user: User },
    gameNumber: number,
  ): Promise<WsResponse<Game>> {
    let game: Game;

    try {
      game = await this.gameService.leaveGame({
        user: client.user,
        gameNumber,
      });
    } catch (error) {
      this.sendError({ client, message: error.response.message });
      return;
    }

    try {
      await this.logService.create({
        type: 'leave',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      this.sendError({ client, message: error.response.message });
      return;
    }

    client.leave(game.id);

    game = JSON.parse(JSON.stringify(await this.gameService.findOne(game.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    this.server.emit(
      'update-game',
      this.gameService.parseGameForAllUsers(game),
    );

    return { event: 'update-opened-game', data: null };
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('close-game')
  public async closeGame(
    client: Socket & { user: User },
  ): Promise<WsResponse<Game>> {
    let game: Game;

    if (!client.user.openedGame) {
      this.sendError({ client, message: 'You don\'t have opened game to close' });
      return;
    }

    try {
      game = await this.gameService.closeGame({
        user: client.user,
        gameNumber: client.user.openedGame.number,
      });
    } catch (error) {
      this.sendError({ client, message: error.response.message });
      return;
    }

    try {
      await this.logService.create({
        type: 'close',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      this.sendError({ client, message: error.response.message });
      return;
    }

    client.leave(game.id);

    game = JSON.parse(JSON.stringify(await this.gameService.findOne(game.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    this.server.emit(
      'update-game',
      this.gameService.parseGameForAllUsers(game),
    );

    return { event: 'update-opened-game', data: null };
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('remove-game')
  public async removeGame(
    client: Socket & { user: User },
    gameNumber: number,
  ): Promise<void> {
    const game = await this.gameService.findOne(gameNumber);

    try {
      await this.gameService.removeGame({ user: client.user, gameNumber });
    } catch (error) {
      this.sendError({ client, message: error.response.message });
      return;
    }

    try {
      await this.inviteService.closeInvites({ gameId: game.id });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    this.kickUsersFromGame({ server: this.server, game });

    this.server.emit('remove-game', gameNumber);
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('repeat-game')
  public async repeatGame(
    client: Socket & { user: User },
    gameNumber: number,
  ): Promise<void> {
    const game = await this.gameService.findOne(gameNumber);

    await this.closeGame(client);

    const newGame = await this.newGame(client, game.name);

    game.players.forEach(async (player: User | IUser) => {
      if (player.id === client.user.id) {
        return;
      }

      const invite = await this.inviteService.create({ gameId: newGame.id, createdBy: client.user, invitee: player.id });
      this.sendInvite({ server: this.server, invite });
    });

    this.updateCurrentUser({ server: this.server, userId: client.user.id });
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('toggle-ready')
  public async toggleReady(
    client: Socket & { user: User },
  ): Promise<void> {
    let game: Game;

    if (!client.user.openedGame) {
      this.sendError({ client, message: 'You don\'t have opened game to toggle ready status' });
      return;
    }

    try {
      game = await this.gameService.toggleReady({
        user: client.user,
        gameNumber: client.user.openedGame.number,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    let log: Log;

    try {
      log = await this.logService.create({
        type: 'ready',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    game.logs = [log, ...game.logs];

    this.sendGameToGameUsers({ server: this.server, game });
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('update-option')
  public async updateOption(
    client: Socket & { user: User },
    { gameNumber, name, value }: { gameNumber: number, name: string, value: string },
  ): Promise<void> {
    let game: Game;

    try {
      game = await this.gameService.updateOption({
        user: client.user,
        gameNumber,
        name,
        value,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    let log: Log;

    try {
      log = await this.logService.create({
        type: 'update',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    game.logs = [log, ...game.logs];

    this.sendGameToGameUsers({ server: this.server, game });
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('start-game')
  public async startGame(
    client: Socket & { user: User },
    gameNumber: number,
  ): Promise<void> {
    let game: Game;

    try {
      game = await this.gameService.startGame({ gameNumber });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    try {
      await this.logService.create({
        type: 'start',
        user: client.user,
        gameId: game.id,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    try {
      await this.inviteService.closeInvites({ gameId: game.id });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    game = JSON.parse(JSON.stringify(await this.gameService.findOne(game.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    this.server.emit(
      'update-game',
      this.gameService.parseGameForAllUsers(game),
    );
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('make-move')
  public async move(
    client: Socket & { user: User },
    { gameNumber, move }: { gameNumber: number; move: string },
  ): Promise<void> {
    if (
      !client.user.currentGames ||
      !client.user.currentGames.some(
        currentGame => currentGame.number === gameNumber,
      )
    ) {
      return this.sendError({
        client,
        message: 'You can\'t make move if you are not this game player',
      });
    }

    let game: Game;

    try {
      game = await this.gameService.makeMove({
        move,
        gameNumber,
        userId: client.user.id,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    try {
      await this.logService.create({
        type: 'move',
        user: client.user,
        gameId: game.id,
        text: move,
      });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    if (game.state === GAME_FINISHED) {
      try {
        await this.logService.create({
          type: 'finish',
          user: client.user,
          gameId: game.id,
        });
      } catch (error) {
        return this.sendError({ client, message: error.response.message });
      }
    }

    game = JSON.parse(JSON.stringify(await this.gameService.findOne(game.number)));

    this.sendGameToGameUsers({ server: this.server, game });
    if (game.state === GAME_FINISHED) {
      this.server.emit(
        'update-game',
        this.gameService.parseGameForAllUsers(game),
      );
    }
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('accept-invite')
  public async acceptInvite(client: Socket & { user: User }, inviteId: string): Promise<void> {
    let invite: Invite | IInvite;

    try {
      invite = await this.inviteService.closeInvite({ inviteId, isAccepted: true });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }

    this.joinGame(client, invite.game.number);
  }

  @UseGuards(JwtGuard)
  @SubscribeMessage('decline-invite')
  public async declineInvite(client: Socket & { user: User }, inviteId: string): Promise<void> {

    let invite: Invite | IInvite;

    try {
      invite = await this.inviteService.closeInvite({ inviteId, isDeclined: true });
    } catch (error) {
      return this.sendError({ client, message: error.response.message });
    }
  }

  private sendInvite({ server, invite }: { server: Server, invite: Invite | IInvite }): void {
    Object.keys(server.sockets.sockets).forEach(async (socketId) => {
      const socketInGame = server.sockets.connected[socketId] as Socket & { user: User };
      const userInGame = socketInGame.user;

      if (userInGame && userInGame.id === invite.invitee.id) {
        socketInGame.emit('new-invite', invite);
      }
    });
  }

  private updateCurrentUser({ server, userId }: { server: Server, userId: string }): void {
    Object.keys(server.sockets.sockets).forEach(async (socketId) => {
      const socketInGame = server.sockets.connected[socketId] as Socket & { user: User };
      const userInGame = socketInGame.user;

      if (userInGame && userInGame.id === userId) {
        const user = await this.userService.findOneByUserId(userId);
        socketInGame.emit('update-current-user', user);
      }
    });
  }

  private kickUsersFromGame({ server, game }: { server: Server, game: Game | IGame }): void {
    if (!server.sockets.adapter.rooms[game.id]) {
      return;
    }

    Object.keys(server.sockets.adapter.rooms[game.id].sockets).forEach(socketId => {
      const socketInGame = server.sockets.connected[socketId] as Socket & { user: User };
      const userInGame = socketInGame.user;

      if (userInGame) {
        socketInGame.emit('update-opened-game', null);
      }
    });
  }

  private sendGameToGameUsers({ server, game }: { server: Server, game: Game | IGame }): void {
    if (!server.sockets.adapter.rooms[game.id]) {
      return;
    }

    Object.keys(server.sockets.adapter.rooms[game.id].sockets).forEach(socketId => {
      const socketInGame = server.sockets.connected[socketId] as Socket & { user: User };
      const userInGame = socketInGame.user;

      if (userInGame) {
        socketInGame.emit('update-opened-game', this.gameService.parseGameForUser({ game, user: userInGame }));
      }
    });
  }

  private sendError({ client, message }: { client: Socket; message: string; }): void {
    this.logger.error(message, '');
    client.emit('error-message', { message });
  }
}
