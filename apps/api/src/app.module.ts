import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

/** Root NestJS module for the M0 spike — no product features (ticket 02). */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
