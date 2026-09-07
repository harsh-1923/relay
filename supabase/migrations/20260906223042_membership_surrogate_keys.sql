ALTER TABLE "conversation_members" DROP CONSTRAINT "conversation_members_conversation_id_actor_id_pk";--> statement-breakpoint
ALTER TABLE "room_members" DROP CONSTRAINT "room_members_room_id_actor_id_pk";--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_actor_key" UNIQUE("conversation_id","actor_id");--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_actor_key" UNIQUE("room_id","actor_id");