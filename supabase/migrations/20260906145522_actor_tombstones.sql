ALTER TABLE "actors" DROP CONSTRAINT "actors_human_check";--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_agent_check";--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_human_check" CHECK ("actors"."user_id" is null or "actors"."kind" = 'human');--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_agent_check" CHECK ("actors"."agent_id" is null or "actors"."kind" = 'agent');