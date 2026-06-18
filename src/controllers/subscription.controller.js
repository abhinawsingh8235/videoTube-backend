import mongoose, { isValidObjectId } from "mongoose"
import { User } from "../models/user.model.js"
import { Subscription } from "../models/subscription.model.js"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"

// ─── 1. TOGGLE SUBSCRIPTION ───────────────────────────────────────────────────
// POST /api/v1/subscriptions/c/:channelId
const toggleSubscription = asyncHandler(async (req, res) => {
    const { channelId } = req.params

    if (!isValidObjectId(channelId)) {
        throw new ApiError(400, "Invalid channelId")
    }

    // User apne aap ko subscribe nahi kar sakta
    if (channelId.toString() === req.user._id.toString()) {
        throw new ApiError(400, "You cannot subscribe to your own channel")
    }

    // Channel (user) exist karta hai ya nahi
    const channel = await User.findById(channelId)
    if (!channel) {
        throw new ApiError(404, "Channel not found")
    }

    // Check karo ki subscription already exist karti hai
    const existingSubscription = await Subscription.findOne({
        subscriber: req.user._id,
        channel: channelId,
    })

    if (existingSubscription) {
        // Already subscribed → unsubscribe
        await Subscription.findByIdAndDelete(existingSubscription._id)

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { isSubscribed: false },
                    "Unsubscribed successfully"
                )
            )
    }

    // Not subscribed yet → subscribe karo
    await Subscription.create({
        subscriber: req.user._id,
        channel: channelId,
    })

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { isSubscribed: true },
                "Subscribed successfully"
            )
        )
})

// ─── 2. GET ALL SUBSCRIBERS OF A CHANNEL ─────────────────────────────────────
// GET /api/v1/subscriptions/u/:subscriberId
const getUserChannelSubscribers = asyncHandler(async (req, res) => {
    const { channelId } = req.params

    if (!isValidObjectId(channelId)) {
        throw new ApiError(400, "Invalid channelId")
    }

    // Channel exist karta hai ya nahi
    const channel = await User.findById(channelId)
    if (!channel) {
        throw new ApiError(404, "Channel not found")
    }

    // Aggregation — is channel ke saare subscribers laao
    const subscribers = await Subscription.aggregate([
        // Stage 1: is channel ke saare subscription documents
        {
            $match: {
                channel: new mongoose.Types.ObjectId(channelId),
            },
        },
        // Stage 2: har subscriber ki user details laao
        {
            $lookup: {
                from: "users",
                localField: "subscriber",
                foreignField: "_id",
                as: "subscriber",
                pipeline: [
                    {
                        $project: {
                            username: 1,
                            fullName: 1,
                            avatar: 1,
                        },
                    },
                ],
            },
        },
        // Stage 3: array se object banao
        {
            $addFields: {
                subscriber: { $first: "$subscriber" },
            },
        },
        // Stage 4: clean output — sirf subscriber object chahiye
        {
            $replaceRoot: { newRoot: "$subscriber" },
        },
        // Stage 5: alphabetical order by username
        {
            $sort: { username: 1 },
        },
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    subscribersCount: subscribers.length,
                    subscribers,
                },
                "Subscribers fetched successfully"
            )
        )
})

// ─── 3. GET ALL CHANNELS A USER HAS SUBSCRIBED TO ────────────────────────────
// GET /api/v1/subscriptions/c/:channelId
const getSubscribedChannels = asyncHandler(async (req, res) => {
    const { subscriberId } = req.params

    if (!isValidObjectId(subscriberId)) {
        throw new ApiError(400, "Invalid subscriberId")
    }

    // User exist karta hai ya nahi
    const subscriber = await User.findById(subscriberId)
    if (!subscriber) {
        throw new ApiError(404, "User not found")
    }

    // Aggregation — is user ne jinhe subscribe kiya unki details laao
    const subscribedChannels = await Subscription.aggregate([
        // Stage 1: is user ke saare subscriptions
        {
            $match: {
                subscriber: new mongoose.Types.ObjectId(subscriberId),
            },
        },
        // Stage 2: channel ki user details laao
        {
            $lookup: {
                from: "users",
                localField: "channel",
                foreignField: "_id",
                as: "channel",
                pipeline: [
                    {
                        $project: {
                            username: 1,
                            fullName: 1,
                            avatar: 1,
                        },
                    },
                ],
            },
        },
        // Stage 3: array se object banao
        {
            $addFields: {
                channel: { $first: "$channel" },
            },
        },
        // Stage 4: channel subscriber count bhi laao (optional but useful)
        {
            $lookup: {
                from: "subscriptions",
                localField: "channel._id",
                foreignField: "channel",
                as: "channelSubscriberCount",
            },
        },
        {
            $addFields: {
                "channel.subscribersCount": {
                    $size: "$channelSubscriberCount",
                },
            },
        },
        // Stage 5: clean output
        {
            $project: {
                _id: 0,
                channel: 1,
                subscribedAt: "$createdAt",
            },
        },
        // Stage 6: latest subscribed channel pehle
        {
            $sort: { subscribedAt: -1 },
        },
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    subscribedChannelsCount: subscribedChannels.length,
                    subscribedChannels,
                },
                "Subscribed channels fetched successfully"
            )
        )
})

export {
    toggleSubscription,
    getUserChannelSubscribers,
    getSubscribedChannels,
}