import mongoose, { isValidObjectId } from "mongoose"
import { Comment } from "../models/comment.model.js"
import { Video } from "../models/video.model.js"
import { Like } from "../models/like.model.js"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"

// ─── 1. GET ALL COMMENTS FOR A VIDEO ─────────────────────────────────────────
// GET /api/v1/comments/:videoId?page=1&limit=10
const getVideoComments = asyncHandler(async (req, res) => {
    const { videoId } = req.params
    const { page = 1, limit = 10 } = req.query

    // Validate videoId
    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    // Check video exists
    const video = await Video.findById(videoId)
    if (!video) {
        throw new ApiError(404, "Video not found")
    }

    // Aggregation pipeline — fetch comments with owner info + like count
    const pipeline = [
        // Stage 1: only comments for this video
        {
            $match: {
                video: new mongoose.Types.ObjectId(videoId),
            },
        },
        // Stage 2: populate owner (username + avatar only)
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [
                    {
                        $project: { username: 1, avatar: 1, fullName: 1 },
                    },
                ],
            },
        },
        {
            $addFields: {
                owner: { $first: "$owner" },
            },
        },
        // Stage 3: count likes on each comment
        {
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "comment",
                as: "likes",
            },
        },
        {
            $addFields: {
                likesCount: { $size: "$likes" },
                // Is the currently logged-in user among the likers?
                isLiked: {
                    $cond: {
                        if: { $in: [req.user?._id, "$likes.likedBy"] },
                        then: true,
                        else: false,
                    },
                },
            },
        },
        // Stage 4: remove the full likes array (we only need count)
        {
            $project: { likes: 0 },
        },
        // Stage 5: newest comments first
        {
            $sort: { createdAt: -1 },
        },
    ]

    const options = {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
    }

    const result = await Comment.aggregatePaginate(
        Comment.aggregate(pipeline),
        options
    )

    return res
        .status(200)
        .json(new ApiResponse(200, result, "Comments fetched successfully"))
})

// ─── 2. ADD A COMMENT ────────────────────────────────────────────────────────
// POST /api/v1/comments/:videoId
const addComment = asyncHandler(async (req, res) => {
    const { videoId } = req.params
    const { content } = req.body

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    if (!content?.trim()) {
        throw new ApiError(400, "Comment content is required")
    }

    // Check video exists
    const video = await Video.findById(videoId)
    if (!video) {
        throw new ApiError(404, "Video not found")
    }

    // Create the comment
    const comment = await Comment.create({
        content: content.trim(),
        video: videoId,
        owner: req.user._id,
    })

    // Populate owner before sending response
    const createdComment = await Comment.findById(comment._id).populate(
        "owner",
        "username avatar fullName"
    )

    if (!createdComment) {
        throw new ApiError(500, "Failed to add comment, please try again")
    }

    return res
        .status(201)
        .json(new ApiResponse(201, createdComment, "Comment added successfully"))
})

// ─── 3. UPDATE A COMMENT ─────────────────────────────────────────────────────
// PATCH /api/v1/comments/c/:commentId
const updateComment = asyncHandler(async (req, res) => {
    const { commentId } = req.params
    const { content } = req.body

    if (!isValidObjectId(commentId)) {
        throw new ApiError(400, "Invalid commentId")
    }

    if (!content?.trim()) {
        throw new ApiError(400, "New comment content is required")
    }

    // Find the comment
    const comment = await Comment.findById(commentId)
    if (!comment) {
        throw new ApiError(404, "Comment not found")
    }

    // Only the owner can update
    if (comment.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to update this comment")
    }

    const updatedComment = await Comment.findByIdAndUpdate(
        commentId,
        { $set: { content: content.trim() } },
        { new: true }
    ).populate("owner", "username avatar fullName")

    return res
        .status(200)
        .json(new ApiResponse(200, updatedComment, "Comment updated successfully"))
})

// ─── 4. DELETE A COMMENT ─────────────────────────────────────────────────────
// DELETE /api/v1/comments/c/:commentId
const deleteComment = asyncHandler(async (req, res) => {
    const { commentId } = req.params

    if (!isValidObjectId(commentId)) {
        throw new ApiError(400, "Invalid commentId")
    }

    // Find the comment
    const comment = await Comment.findById(commentId)
    if (!comment) {
        throw new ApiError(404, "Comment not found")
    }

    // Only the owner can delete
    if (comment.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to delete this comment")
    }

    // Delete the comment
    await Comment.findByIdAndDelete(commentId)

    // Also delete all likes on this comment
    await Like.deleteMany({ comment: commentId })

    return res
        .status(200)
        .json(
            new ApiResponse(200, { commentId }, "Comment deleted successfully")
        )
})

export { getVideoComments, addComment, updateComment, deleteComment }
